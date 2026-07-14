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

test('retry guard reports head, snapshot, index, file, and clean states', async () => {
  const approved = snapshot()
  const changed = snapshot(['src/value.ts'])
  const cases: readonly {
    readonly name: string
    readonly guardHead: string
    readonly current: RepositorySnapshot | null
    readonly expected: string | null
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
    {
      name: 'index',
      guardHead: HEAD,
      current: snapshot([], 'changed-index'),
      expected: 'stage changed Git index',
    },
    {
      name: 'file',
      guardHead: HEAD,
      current: changed,
      expected: 'stage changed files before retry: src/value.ts',
    },
    { name: 'clean', guardHead: HEAD, current: approved, expected: null },
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
