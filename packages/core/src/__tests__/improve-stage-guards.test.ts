import { expect, test } from 'bun:test'

import type { ItemStageRun } from '../improve-runner.ts'
import { createImproveStageExecutor } from '../improve-stage.ts'
import { resolveImproveItemPaths, resolvePaths } from '../paths.ts'
import type { RepositorySnapshot } from '../repository-snapshot.ts'
import type { BatchItemStatus, ImproveStage, Signal } from '../types.ts'

const HEAD = 'approved-head'

type FileEntry = {
  readonly kind: 'file'
  readonly content: Buffer
  readonly mode: number
}

function snapshot(
  files: readonly string[] = [],
  indexTree = 'approved-index',
): RepositorySnapshot {
  const entries = new Map<string, FileEntry>()
  for (const path of files) {
    entries.set(path, {
      kind: 'file',
      content: Buffer.from(path),
      mode: 0o644,
    })
  }
  return { head: HEAD, indexTree, indexFile: Buffer.from(indexTree), entries }
}

function stageRun(root: string, stage: ImproveStage): ItemStageRun {
  return {
    role: stage === 'review' ? 'review' : 'improve',
    stage,
    item: { id: '1', title: 'item 1' },
    itemIndex: 0,
    artifacts: resolveImproveItemPaths(resolvePaths(root), 1, 0, stage, '1'),
    message: '',
  }
}

function signal(
  run: ItemStageRun,
  status: BatchItemStatus,
  files: readonly string[] = [],
): Signal {
  return {
    iteration: 1,
    phase: 'improve',
    result: status === 'kept' ? 'applied' : 'applied_reverted',
    report: run.artifacts.report,
    appliedImprovements: [
      { id: run.item.id, title: run.item.title, status, files },
    ],
    summary: status,
    timestamp: '2026-07-14T00:00:00.000Z',
  }
}

test('unavailable initial repository snapshot fails before execution', async () => {
  const root = 'C:/retry-now-missing-snapshot'
  const logs: string[] = []
  let executed = false
  const execute = createImproveStageExecutor({
    paths: resolvePaths(root),
    scope: '',
    dryRun: false,
    initialBaseline: [],
    log: (line) => logs.push(line),
    validate: () => null,
    executePhase: () => {
      executed = true
      return Promise.resolve({ kind: 'failed' })
    },
    repository: {
      capture: () => Promise.resolve(null),
      head: () => Promise.resolve(HEAD),
      restoreIndex: () => Promise.resolve(null),
      restoreSnapshot: () => Promise.resolve(null),
    },
  })

  expect(await execute(stageRun(root, 'implement'))).toEqual({ kind: 'failed' })
  expect(executed).toBe(false)
  expect(logs).toContain('  ! item 1 repository snapshot is unavailable')
})

test('dry run delegates stage paths, validation, and a no-op guard', async () => {
  const root = 'C:/retry-now-dry-run'
  const run = stageRun(root, 'implement')
  let validationCalled = false
  const execute = createImproveStageExecutor({
    paths: resolvePaths(root),
    scope: '',
    dryRun: true,
    initialBaseline: [],
    log: () => undefined,
    validate: () => {
      validationCalled = true
      return null
    },
    executePhase: async (paths, validate, retryGuard) => {
      expect(paths.current).toBe(run.artifacts.current)
      expect(validate(signal(run, 'kept'))).toBeNull()
      expect(await retryGuard()).toBeNull()
      return { kind: 'ok', signal: signal(run, 'kept') }
    },
  })

  expect((await execute(run)).kind).toBe('ok')
  expect(validationCalled).toBe(true)
})

test('retry guard hard-stops on a Git HEAD change or an unreadable snapshot', async () => {
  const approved = snapshot()
  const cases: readonly {
    readonly name: string
    readonly guardHead: string
    readonly current: RepositorySnapshot | null
    readonly expected: string
  }[] = [
    {
      name: 'head',
      guardHead: 'changed-head',
      current: approved,
      expected: 'Git HEAD changed during item 1 implement',
    },
    {
      name: 'snapshot',
      guardHead: HEAD,
      current: null,
      expected: 'current repository snapshot is unavailable',
    },
  ]

  for (const scenario of cases) {
    const root = `C:/retry-now-guard-${scenario.name}`
    let captures = 0
    let heads = 0
    const observed: (string | null)[] = []
    const execute = createImproveStageExecutor({
      paths: resolvePaths(root),
      scope: '',
      dryRun: false,
      initialBaseline: [],
      log: () => undefined,
      validate: () => null,
      executePhase: async (_paths, validate, retryGuard, run) => {
        expect(validate(signal(run, 'kept'))).toBeNull()
        observed.push(await retryGuard())
        return { kind: 'failed' }
      },
      repository: {
        capture: () =>
          Promise.resolve(captures++ === 0 ? approved : scenario.current),
        head: () => Promise.resolve(heads++ === 0 ? scenario.guardHead : HEAD),
        restoreIndex: () => Promise.resolve(null),
        restoreSnapshot: () => Promise.resolve(null),
      },
    })

    expect(await execute(stageRun(root, 'implement'))).toEqual({
      kind: 'failed',
    })
    expect(observed).toEqual([scenario.expected])
  }
})

test('retry guard is a no-op when the tree already matches the pre-stage snapshot', async () => {
  const approved = snapshot()
  const root = 'C:/retry-now-guard-clean'
  const logs: string[] = []
  const execute = createImproveStageExecutor({
    paths: resolvePaths(root),
    scope: '',
    dryRun: false,
    initialBaseline: [],
    log: (line) => logs.push(line),
    validate: () => null,
    executePhase: async (_paths, validate, retryGuard, run) => {
      expect(validate(signal(run, 'kept'))).toBeNull()
      expect(await retryGuard()).toBeNull()
      return { kind: 'failed' }
    },
    repository: {
      capture: () => Promise.resolve(approved),
      head: () => Promise.resolve(HEAD),
      restoreIndex: () => Promise.resolve(null),
      restoreSnapshot: () => Promise.resolve(null),
    },
  })

  expect(await execute(stageRun(root, 'implement'))).toEqual({ kind: 'failed' })
  // The post-outcome cleanup (restoreApproved) still runs because executePhase
  // ultimately failed, but it succeeds silently — only the guard itself logs when
  // it had to restore something, and a clean tree never reaches that branch.
  expect(logs.some((line) => line.includes('restored attempt changes'))).toBe(
    false,
  )
})

test('retry guard restores a dirty index or working tree to the pre-stage snapshot and allows the retry', async () => {
  const approved = snapshot()
  const changed = snapshot(['src/value.ts'])
  const cases: readonly {
    readonly name: string
    readonly current: RepositorySnapshot
    readonly expectedDirt: string
  }[] = [
    {
      name: 'index',
      current: snapshot([], 'changed-index'),
      expectedDirt: 'Git index',
    },
    { name: 'file', current: changed, expectedDirt: 'src/value.ts' },
  ]

  for (const scenario of cases) {
    const root = `C:/retry-now-guard-restore-${scenario.name}`
    const logs: string[] = []
    let captures = 0
    let firstRestoreTarget: RepositorySnapshot | undefined
    const execute = createImproveStageExecutor({
      paths: resolvePaths(root),
      scope: '',
      dryRun: false,
      initialBaseline: [],
      log: (line) => logs.push(line),
      validate: () => null,
      executePhase: async (_paths, validate, retryGuard, run) => {
        expect(validate(signal(run, 'kept'))).toBeNull()
        expect(await retryGuard()).toBeNull()
        return { kind: 'failed' }
      },
      repository: {
        capture: () =>
          Promise.resolve(captures++ === 0 ? approved : scenario.current),
        head: () => Promise.resolve(HEAD),
        restoreIndex: () => Promise.resolve(null),
        restoreSnapshot: (_root, target) => {
          firstRestoreTarget ??= target
          return Promise.resolve(null)
        },
      },
    })

    expect(await execute(stageRun(root, 'implement'))).toEqual({
      kind: 'failed',
    })
    // The guard's own restore (asserted via its log line below) runs before the
    // post-outcome restoreApproved cleanup, so the first observed call is the guard's.
    expect(firstRestoreTarget).toBe(approved)
    expect(
      logs.some((line) =>
        line.includes(
          `restored attempt changes before retry: ${scenario.expectedDirt}`,
        ),
      ),
    ).toBe(true)
  }
})

test('retry guard reports a failed or thrown restore instead of allowing an unsafe retry', async () => {
  const approved = snapshot()
  const changed = snapshot(['src/value.ts'])
  const cases: readonly {
    readonly name: string
    readonly restoreSnapshot: () => Promise<string | null>
    readonly expected: string
  }[] = [
    {
      name: 'rejected',
      restoreSnapshot: () => Promise.resolve('disk full'),
      expected: 'could not restore repository before retry: disk full',
    },
    {
      name: 'threw',
      restoreSnapshot: () => Promise.reject(new Error('EBUSY')),
      expected: 'repository restoration threw before retry: EBUSY',
    },
  ]

  for (const scenario of cases) {
    const root = `C:/retry-now-guard-restore-failure-${scenario.name}`
    let captures = 0
    const observed: (string | null)[] = []
    const execute = createImproveStageExecutor({
      paths: resolvePaths(root),
      scope: '',
      dryRun: false,
      initialBaseline: [],
      log: () => undefined,
      validate: () => null,
      executePhase: async (_paths, validate, retryGuard, run) => {
        expect(validate(signal(run, 'kept'))).toBeNull()
        observed.push(await retryGuard())
        return { kind: 'failed' }
      },
      repository: {
        capture: () => Promise.resolve(captures++ === 0 ? approved : changed),
        head: () => Promise.resolve(HEAD),
        restoreIndex: () => Promise.resolve(null),
        restoreSnapshot: scenario.restoreSnapshot,
      },
    })

    expect(await execute(stageRun(root, 'implement'))).toEqual({
      kind: 'failed',
    })
    expect(observed).toEqual([scenario.expected])
  }
})

test('regression: a first attempt that dirties the tree and fails no longer sacrifices the item — the guard cleans up so a second attempt can succeed', async () => {
  const approved = snapshot()
  const dirtyFromAttempt1 = snapshot(['src/value.ts'])
  const root = 'C:/retry-now-guard-regression'
  let captures = 0
  const execute = createImproveStageExecutor({
    paths: resolvePaths(root),
    scope: '',
    dryRun: false,
    initialBaseline: [],
    log: () => undefined,
    validate: () => null,
    executePhase: async (_paths, _validate, retryGuard, run) => {
      // Mirrors runPhaseResilient: attempt 1 wrote files but emitted an invalid
      // signal, so it calls the guard before attempt 2. Previously that would refuse
      // the retry outright; now it must clean up and return null so attempt 2 proceeds.
      const retryIssue = await retryGuard()
      if (retryIssue !== null) return { kind: 'failed' }
      return { kind: 'ok', signal: signal(run, 'kept', ['src/value.ts']) }
    },
    repository: {
      capture: () =>
        Promise.resolve(captures++ === 0 ? approved : dirtyFromAttempt1),
      head: () => Promise.resolve(HEAD),
      restoreIndex: () => Promise.resolve(null),
      restoreSnapshot: () => Promise.resolve(null),
    },
  })

  expect((await execute(stageRun(root, 'implement'))).kind).toBe('ok')
})

test('index and rollback failures are both reported', async () => {
  const root = 'C:/retry-now-index-failure'
  const logs: string[] = []
  const execute = createImproveStageExecutor({
    paths: resolvePaths(root),
    scope: '',
    dryRun: false,
    initialBaseline: [],
    log: (line) => logs.push(line),
    validate: () => null,
    executePhase: async (_paths, _validate, _retryGuard, run) => ({
      kind: 'ok',
      signal: signal(run, 'kept'),
    }),
    repository: {
      capture: () => Promise.resolve(snapshot()),
      head: () => Promise.resolve(HEAD),
      restoreIndex: () => Promise.resolve('index unavailable'),
      restoreSnapshot: () => Promise.resolve('rollback unavailable'),
    },
  })

  expect(await execute(stageRun(root, 'implement'))).toEqual({ kind: 'failed' })
  expect(logs).toContain(
    '  ! item 1 index restoration failed — index unavailable',
  )
  expect(logs).toContain('  ! item 1 rollback failed — rollback unavailable')
})

test('a thrown index restoration is reported and triggers rollback instead of crashing', async () => {
  const root = 'C:/retry-now-index-throw'
  const logs: string[] = []
  const execute = createImproveStageExecutor({
    paths: resolvePaths(root),
    scope: '',
    dryRun: false,
    initialBaseline: [],
    log: (line) => logs.push(line),
    validate: () => null,
    executePhase: async (_paths, _validate, _retryGuard, run) => ({
      kind: 'ok',
      signal: signal(run, 'kept'),
    }),
    repository: {
      capture: () => Promise.resolve(snapshot()),
      head: () => Promise.resolve(HEAD),
      restoreIndex: () => Promise.reject(new Error('EBUSY')),
      restoreSnapshot: () => Promise.resolve(null),
    },
  })

  expect(await execute(stageRun(root, 'implement'))).toEqual({ kind: 'failed' })
  expect(logs).toContain('  ! item 1 index restoration threw — EBUSY')
})

test('missing post-index snapshot restores the approved state and fails', async () => {
  const root = 'C:/retry-now-post-index-snapshot'
  let captures = 0
  let restores = 0
  const execute = createImproveStageExecutor({
    paths: resolvePaths(root),
    scope: '',
    dryRun: false,
    initialBaseline: [],
    log: () => undefined,
    validate: () => null,
    executePhase: async (_paths, _validate, _retryGuard, run) => ({
      kind: 'ok',
      signal: signal(run, 'kept'),
    }),
    repository: {
      capture: () => Promise.resolve(captures++ === 0 ? snapshot() : null),
      head: () => Promise.resolve(HEAD),
      restoreIndex: () => Promise.resolve(null),
      restoreSnapshot: () => {
        restores += 1
        return Promise.resolve(null)
      },
    },
  })

  expect(await execute(stageRun(root, 'implement'))).toEqual({ kind: 'failed' })
  expect(restores).toBe(1)
})

test('review with an unsafe delta restores the approved snapshot', async () => {
  const root = 'C:/retry-now-unsafe-review'
  const approved = snapshot()
  const implemented = snapshot(['packages/a/value.ts'])
  const unsafe = snapshot(['packages/a/value.ts', 'packages/b/value.ts'])
  const captures = [approved, implemented, unsafe]
  const logs: string[] = []
  let restoreCalls = 0
  const execute = createImproveStageExecutor({
    paths: resolvePaths(root),
    scope: 'packages/a',
    dryRun: false,
    initialBaseline: [],
    log: (line) => logs.push(line),
    validate: () => null,
    executePhase: async (_paths, _validate, _retryGuard, run) => ({
      kind: 'ok',
      signal: signal(run, 'kept', ['packages/a/value.ts']),
    }),
    repository: {
      capture: () => Promise.resolve(captures.shift() ?? null),
      head: () => Promise.resolve(HEAD),
      restoreIndex: () => Promise.resolve(null),
      restoreSnapshot: () => {
        restoreCalls += 1
        return Promise.resolve(null)
      },
    },
  })

  expect((await execute(stageRun(root, 'implement'))).kind).toBe('ok')
  expect(await execute(stageRun(root, 'review'))).toEqual({ kind: 'failed' })
  expect(logs.some((line) => line.includes('review left an unsafe tree'))).toBe(
    true,
  )
  expect(restoreCalls).toBe(1)
})
