import { expect, test } from 'bun:test'

import type { ItemStageRun } from '../improve-runner.ts'
import { validateImproveSignal } from '../improve-signal.ts'
import { createImproveStageExecutor } from '../improve-stage.ts'
import { resolveImproveItemPaths, resolvePaths } from '../paths.ts'
import type { RepositorySnapshot } from '../repository-snapshot.ts'
import type {
  BatchItemStatus,
  ImproveStage,
  PlannedImprovement,
  Signal,
} from '../types.ts'

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

function stageRun(
  root: string,
  stage: ImproveStage,
  item: PlannedImprovement = { id: '1', title: 'item 1' },
): ItemStageRun {
  return {
    role: stage === 'review' ? 'review' : 'improve',
    stage,
    item,
    itemIndex: Number(item.id) - 1,
    artifacts: resolveImproveItemPaths(
      resolvePaths(root),
      1,
      Number(item.id) - 1,
      stage,
      item.id,
    ),
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
    result:
      status === 'kept'
        ? 'applied'
        : status === 'reverted'
          ? 'applied_reverted'
          : 'failed',
    report: run.artifacts.report,
    plannedCount: 1,
    appliedImprovements: [
      {
        id: run.item.id,
        title: run.item.title,
        status,
        impact: 'agent impact',
        decisionReason: 'agent decision',
        files,
      },
    ],
    keptCount: status === 'kept' ? 1 : 0,
    revertedCount: status === 'reverted' ? 1 : 0,
    failedCount: status === 'failed' ? 1 : 0,
    skippedCount: status === 'skipped' ? 1 : 0,
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
      return Promise.resolve({ kind: 'failed', reason: 'stage failed' })
    },
    repository: {
      capture: () => Promise.resolve(null),
      head: () => Promise.resolve(HEAD),
      restoreIndex: () => Promise.resolve(null),
      restoreSnapshot: () => Promise.resolve(null),
    },
  })

  expect(await execute(stageRun(root, 'implement'))).toEqual({
    kind: 'failed',
    repository: 'unknown',
    reason: 'repository snapshot is unavailable',
  })
  expect(executed).toBe(false)
  expect(logs).toContain('  ! item 1 repository snapshot is unavailable')
})

test('dry run delegates stage paths, validation, and a no-op guard', async () => {
  const root = 'C:/retry-now-dry-run'
  const run = stageRun(root, 'implement')
  let validationCalled = false
  let verificationCalls = 0
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
    verifyKept: () => {
      verificationCalls += 1
      return Promise.resolve('must not run')
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
  expect(verificationCalls).toBe(0)
})

test('a green driver gate keeps the item and advances the approved snapshot', async () => {
  // Given
  const root = 'C:/retry-now-green-verification'
  const firstItem = { id: '1', title: 'item 1' }
  const secondItem = { id: '2', title: 'item 2' }
  const initial = snapshot()
  const firstApproved = snapshot(['src/one.ts'])
  const secondCandidate = snapshot(['src/one.ts', 'src/two.ts'])
  const restored: RepositorySnapshot[] = []
  let current = initial
  let verificationCalls = 0
  const execute = createImproveStageExecutor({
    paths: resolvePaths(root),
    scope: '',
    dryRun: false,
    initialBaseline: [],
    initialSnapshot: initial,
    log: () => undefined,
    validate: () => null,
    verifyKept: () => {
      verificationCalls += 1
      return Promise.resolve(null)
    },
    executePhase: async (_paths, _validate, _retryGuard, run) => {
      const files =
        run.item.id === firstItem.id ? ['src/one.ts'] : ['src/two.ts']
      if (run.stage === 'implement') {
        current = run.item.id === firstItem.id ? firstApproved : secondCandidate
      }
      const status =
        run.stage === 'review' && run.item.id === secondItem.id
          ? 'reverted'
          : 'kept'
      return { kind: 'ok', signal: signal(run, status, files) }
    },
    repository: {
      capture: () => Promise.resolve(current),
      head: () => Promise.resolve(HEAD),
      restoreIndex: () => Promise.resolve(null),
      restoreSnapshot: (_root, target) => {
        restored.push(target)
        current = target
        return Promise.resolve(null)
      },
    },
  })

  // When
  await execute(stageRun(root, 'implement', firstItem))
  const firstReview = await execute(stageRun(root, 'review', firstItem))
  await execute(stageRun(root, 'implement', secondItem))
  const secondReview = await execute(stageRun(root, 'review', secondItem))

  // Then
  expect(firstReview.kind).toBe('ok')
  if (firstReview.kind === 'ok') {
    expect(firstReview.signal.appliedImprovements?.[0]?.status).toBe('kept')
  }
  expect(verificationCalls).toBe(1)
  expect(secondReview.kind).toBe('ok')
  expect(current).toBe(firstApproved)
  expect(restored).toEqual([firstApproved])
})

test('a red driver gate rewrites the verdict, restores the item, and allows the next item', async () => {
  // Given
  const root = 'C:/retry-now-red-verification'
  const firstItem = { id: '1', title: 'item 1' }
  const secondItem = { id: '2', title: 'item 2' }
  const initial = snapshot()
  const firstCandidate = snapshot(['src/one.ts'])
  const secondCandidate = snapshot(['src/two.ts'])
  const detail = 'lint: `run lint` → exit 1'
  const logs: string[] = []
  let current = initial
  let verificationCalls = 0
  const execute = createImproveStageExecutor({
    paths: resolvePaths(root),
    scope: '',
    dryRun: false,
    initialBaseline: [],
    initialSnapshot: initial,
    log: (line) => logs.push(line),
    validate: () => null,
    verifyKept: () => {
      verificationCalls += 1
      return Promise.resolve(verificationCalls === 1 ? detail : null)
    },
    executePhase: async (_paths, _validate, _retryGuard, run) => {
      const first = run.item.id === firstItem.id
      const files = first ? ['src/one.ts'] : ['src/two.ts']
      if (run.stage === 'implement') {
        current = first ? firstCandidate : secondCandidate
      }
      return { kind: 'ok', signal: signal(run, 'kept', files) }
    },
    repository: {
      capture: () => Promise.resolve(current),
      head: () => Promise.resolve(HEAD),
      restoreIndex: () => Promise.resolve(null),
      restoreSnapshot: (_root, target) => {
        current = target
        return Promise.resolve(null)
      },
    },
  })

  // When
  await execute(stageRun(root, 'implement', firstItem))
  const firstReview = await execute(stageRun(root, 'review', firstItem))
  await execute(stageRun(root, 'implement', secondItem))
  const secondReview = await execute(stageRun(root, 'review', secondItem))

  // Then
  expect(firstReview).toEqual({
    kind: 'ok',
    signal: {
      iteration: 1,
      phase: 'improve',
      result: 'applied_reverted',
      report: stageRun(root, 'review', firstItem).artifacts.report,
      plannedCount: 1,
      appliedImprovements: [
        {
          id: firstItem.id,
          title: firstItem.title,
          status: 'reverted',
          impact: 'agent impact',
          decisionReason: `Driver re-ran configured verification after this item and it failed: ${detail}`,
          files: [],
        },
      ],
      keptCount: 0,
      revertedCount: 1,
      failedCount: 0,
      skippedCount: 0,
      summary: 'kept',
      timestamp: '2026-07-14T00:00:00.000Z',
    },
  })
  expect(logs).toContain(
    `  ! item 1 review kept an item the driver could not verify — ${detail}`,
  )
  expect(secondReview.kind).toBe('ok')
  if (secondReview.kind === 'ok') {
    expect(secondReview.signal.appliedImprovements?.[0]?.status).toBe('kept')
  }
  expect(verificationCalls).toBe(2)
  expect(current).toBe(secondCandidate)
})

test('a red driver gate fails with unknown repository state when restoration cannot be proven', async () => {
  // Given
  const root = 'C:/retry-now-red-verification-unknown'
  const initial = snapshot()
  const candidate = snapshot(['src/value.ts'])
  let current = initial
  const execute = createImproveStageExecutor({
    paths: resolvePaths(root),
    scope: '',
    dryRun: false,
    initialBaseline: [],
    initialSnapshot: initial,
    log: () => undefined,
    validate: () => null,
    verifyKept: () => Promise.resolve('test: `run tests` → exit 2'),
    executePhase: async (_paths, _validate, _retryGuard, run) => {
      if (run.stage === 'implement') current = candidate
      return {
        kind: 'ok',
        signal: signal(run, 'kept', ['src/value.ts']),
      }
    },
    repository: {
      capture: () => Promise.resolve(current),
      head: () => Promise.resolve(HEAD),
      restoreIndex: () => Promise.resolve(null),
      restoreSnapshot: () => Promise.resolve(null),
    },
  })

  // When
  await execute(stageRun(root, 'implement'))
  const outcome = await execute(stageRun(root, 'review'))

  // Then
  expect(outcome).toEqual({
    kind: 'failed',
    repository: 'unknown',
    reason:
      'could not prove the approved repository after failed driver verification',
  })
})

test('an absent driver gate preserves the accepted review signal unchanged', async () => {
  // Given
  const root = 'C:/retry-now-verification-not-injected'
  const initial = snapshot()
  const candidate = snapshot(['src/value.ts'])
  let current = initial
  let reviewSignal: Signal | null = null
  const execute = createImproveStageExecutor({
    paths: resolvePaths(root),
    scope: '',
    dryRun: false,
    initialBaseline: [],
    initialSnapshot: initial,
    log: () => undefined,
    validate: () => null,
    executePhase: async (_paths, _validate, _retryGuard, run) => {
      if (run.stage === 'implement') current = candidate
      const emitted = signal(run, 'kept', ['src/value.ts'])
      if (run.stage === 'review') reviewSignal = emitted
      return { kind: 'ok', signal: emitted }
    },
    repository: {
      capture: () => Promise.resolve(current),
      head: () => Promise.resolve(HEAD),
      restoreIndex: () => Promise.resolve(null),
      restoreSnapshot: (_root, target) => {
        current = target
        return Promise.resolve(null)
      },
    },
  })

  // When
  await execute(stageRun(root, 'implement'))
  const outcome = await execute(stageRun(root, 'review'))

  // Then
  expect(reviewSignal).not.toBeNull()
  expect(outcome.kind).toBe('ok')
  if (outcome.kind === 'ok') {
    expect(JSON.stringify(outcome.signal)).toBe(JSON.stringify(reviewSignal))
  }
})

test('the driver-rewritten reverted signal passes single-item validation', async () => {
  // Given
  const root = 'C:/retry-now-verification-signal-validation'
  const item = { id: '1', title: 'item 1' }
  const initial = snapshot()
  const candidate = snapshot(['src/value.ts'])
  let current = initial
  const execute = createImproveStageExecutor({
    paths: resolvePaths(root),
    scope: '',
    dryRun: false,
    initialBaseline: [],
    initialSnapshot: initial,
    log: () => undefined,
    validate: () => null,
    verifyKept: () => Promise.resolve('test: `run tests` → exit 3'),
    executePhase: async (_paths, _validate, _retryGuard, run) => {
      if (run.stage === 'implement') current = candidate
      return {
        kind: 'ok',
        signal: signal(run, 'kept', ['src/value.ts']),
      }
    },
    repository: {
      capture: () => Promise.resolve(current),
      head: () => Promise.resolve(HEAD),
      restoreIndex: () => Promise.resolve(null),
      restoreSnapshot: (_root, target) => {
        current = target
        return Promise.resolve(null)
      },
    },
  })

  // When
  await execute(stageRun(root, 'implement', item))
  const outcome = await execute(stageRun(root, 'review', item))

  // Then
  expect(outcome.kind).toBe('ok')
  if (outcome.kind === 'ok') {
    expect(validateImproveSignal(outcome.signal, [item])).toBeNull()
  }
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
        return { kind: 'failed', reason: 'stage failed' }
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
      repository: scenario.current === null ? 'unknown' : 'approved',
      reason: 'stage failed',
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
      return { kind: 'failed', reason: 'stage failed' }
    },
    repository: {
      capture: () => Promise.resolve(approved),
      head: () => Promise.resolve(HEAD),
      restoreIndex: () => Promise.resolve(null),
      restoreSnapshot: () => Promise.resolve(null),
    },
  })

  expect(await execute(stageRun(root, 'implement'))).toEqual({
    kind: 'failed',
    repository: 'approved',
    reason: 'stage failed',
  })
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
    let current = approved
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
        current = scenario.current
        expect(await retryGuard()).toBeNull()
        return { kind: 'failed', reason: 'stage failed' }
      },
      repository: {
        capture: () => Promise.resolve(captures++ === 0 ? approved : current),
        head: () => Promise.resolve(HEAD),
        restoreIndex: () => Promise.resolve(null),
        restoreSnapshot: (_root, target) => {
          firstRestoreTarget ??= target
          current = target
          return Promise.resolve(null)
        },
      },
    })

    expect(await execute(stageRun(root, 'implement'))).toEqual({
      kind: 'failed',
      repository: 'approved',
      reason: 'stage failed',
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
        return { kind: 'failed', reason: 'stage failed' }
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
      repository: 'unknown',
      reason: 'stage failed',
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
      if (retryIssue !== null) {
        return { kind: 'failed', reason: retryIssue }
      }
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

  expect(await execute(stageRun(root, 'implement'))).toEqual({
    kind: 'failed',
    repository: 'approved',
    reason: 'index restoration failed: index unavailable',
  })
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

  expect(await execute(stageRun(root, 'implement'))).toEqual({
    kind: 'failed',
    repository: 'approved',
    reason: 'index restoration threw: EBUSY',
  })
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

  expect(await execute(stageRun(root, 'implement'))).toEqual({
    kind: 'failed',
    repository: 'unknown',
    reason: 'repository snapshot is unavailable after index restoration',
  })
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
      capture: () => Promise.resolve(captures.shift() ?? approved),
      head: () => Promise.resolve(HEAD),
      restoreIndex: () => Promise.resolve(null),
      restoreSnapshot: () => {
        restoreCalls += 1
        return Promise.resolve(null)
      },
    },
  })

  expect((await execute(stageRun(root, 'implement'))).kind).toBe('ok')
  expect(await execute(stageRun(root, 'review'))).toEqual({
    kind: 'failed',
    repository: 'approved',
    reason: 'unreported changed file: packages/b/value.ts',
  })
  expect(logs.some((line) => line.includes('review left an unsafe tree'))).toBe(
    true,
  )
  expect(restoreCalls).toBe(1)
})

test('failed stage reports approved when fresh proof matches despite a restore error', async () => {
  // Given
  const root = 'C:/retry-now-approved-after-restore-error'
  const approved = snapshot()
  const execute = createImproveStageExecutor({
    paths: resolvePaths(root),
    scope: '',
    dryRun: false,
    initialBaseline: [],
    initialSnapshot: approved,
    log: () => undefined,
    validate: () => null,
    executePhase: () =>
      Promise.resolve({ kind: 'failed', reason: 'no valid signal' }),
    repository: {
      capture: () => Promise.resolve(approved),
      head: () => Promise.resolve(HEAD),
      restoreIndex: () => Promise.resolve(null),
      restoreSnapshot: () => Promise.resolve('spurious restore failure'),
    },
  })

  // When / Then
  expect<unknown>(await execute(stageRun(root, 'implement'))).toEqual({
    kind: 'failed',
    repository: 'approved',
    reason: 'no valid signal',
  })
})

test('failed stage reports unknown when restore success lacks fresh proof', async () => {
  // Given
  const root = 'C:/retry-now-unknown-after-restore'
  const approved = snapshot()
  const execute = createImproveStageExecutor({
    paths: resolvePaths(root),
    scope: '',
    dryRun: false,
    initialBaseline: [],
    initialSnapshot: approved,
    log: () => undefined,
    validate: () => null,
    executePhase: () =>
      Promise.resolve({ kind: 'failed', reason: 'invalid signal' }),
    repository: {
      capture: () => Promise.resolve(null),
      head: () => Promise.resolve(HEAD),
      restoreIndex: () => Promise.resolve(null),
      restoreSnapshot: () => Promise.resolve(null),
    },
  })

  // When / Then
  expect<unknown>(await execute(stageRun(root, 'implement'))).toEqual({
    kind: 'failed',
    repository: 'unknown',
    reason: 'invalid signal',
  })
})

test('failed stage reports unknown when fresh proof capture throws', async () => {
  // Given
  const root = 'C:/retry-now-throwing-restore-proof'
  const logs: string[] = []
  const execute = createImproveStageExecutor({
    paths: resolvePaths(root),
    scope: '',
    dryRun: false,
    initialBaseline: [],
    initialSnapshot: snapshot(),
    log: (line) => logs.push(line),
    validate: () => null,
    executePhase: () =>
      Promise.resolve({ kind: 'failed', reason: 'invalid signal' }),
    repository: {
      capture: () => Promise.reject(new Error('capture failed')),
      head: () => Promise.resolve(HEAD),
      restoreIndex: () => Promise.resolve(null),
      restoreSnapshot: () => Promise.resolve(null),
    },
  })

  // When / Then
  expect(await execute(stageRun(root, 'implement'))).toEqual({
    kind: 'failed',
    repository: 'unknown',
    reason: 'invalid signal',
  })
  expect(logs).toContain('  ! item 1 rollback proof threw — capture failed')
})

test('quota becomes a repository-unknown failure when rollback cannot be proven', async () => {
  // Given
  const root = 'C:/retry-now-quota-unknown'
  const execute = createImproveStageExecutor({
    paths: resolvePaths(root),
    scope: '',
    dryRun: false,
    initialBaseline: [],
    initialSnapshot: snapshot(),
    log: () => undefined,
    validate: () => null,
    executePhase: () => Promise.resolve({ kind: 'quota' }),
    repository: {
      capture: () => Promise.resolve(null),
      head: () => Promise.resolve(HEAD),
      restoreIndex: () => Promise.resolve(null),
      restoreSnapshot: () => Promise.resolve(null),
    },
  })

  // When / Then
  expect(await execute(stageRun(root, 'implement'))).toEqual({
    kind: 'failed',
    repository: 'unknown',
    reason: 'could not prove the approved repository after quota',
  })
})

test('rejected review becomes a repository-unknown failure when rollback proof is unavailable', async () => {
  // Given
  const root = 'C:/retry-now-rejected-review-unknown'
  const approved = snapshot()
  const implemented = snapshot(['src/value.ts'])
  const captures: (RepositorySnapshot | null)[] = [
    implemented,
    implemented,
    null,
  ]
  const execute = createImproveStageExecutor({
    paths: resolvePaths(root),
    scope: '',
    dryRun: false,
    initialBaseline: [],
    initialSnapshot: approved,
    log: () => undefined,
    validate: () => null,
    executePhase: async (_paths, _validate, _retryGuard, run) => ({
      kind: 'ok',
      signal: signal(run, run.stage === 'implement' ? 'kept' : 'reverted', [
        'src/value.ts',
      ]),
    }),
    repository: {
      capture: () => Promise.resolve(captures.shift() ?? null),
      head: () => Promise.resolve(HEAD),
      restoreIndex: () => Promise.resolve(null),
      restoreSnapshot: () => Promise.resolve(null),
    },
  })

  expect((await execute(stageRun(root, 'implement'))).kind).toBe('ok')

  // When / Then
  expect(await execute(stageRun(root, 'review'))).toEqual({
    kind: 'failed',
    repository: 'unknown',
    reason: 'could not prove the approved repository after rejected review',
  })
})
