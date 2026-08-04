/**
 * How the driver ends a batch that did NOT finish cleanly.
 *
 * These are the paths that decide whether independently-reviewed work survives, and they had no test
 * at all before: the loop driver was excluded from the coverage threshold, so ~130 lines of
 * sequential guards around the "reviewed prefix" commit were only ever exercised by hand.
 *
 * The distinction being pinned here is deliberate and easy to get backwards:
 *   - a mid-batch machine FAILURE commits the prefix that already passed review, then stops;
 *   - a mid-batch QUOTA/ABORT rolls the whole iteration back, because the run will be retried from
 *     scratch and a half-applied plan must not be adopted silently.
 */
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'

import type {
  AgentBackend,
  PhaseInvocationRequest,
  PhaseRunResult,
} from '../agent-backend.ts'
import { runGit } from '../git.ts'
import { writeJson, writeText } from '../io.ts'
import { isPidAlive } from '../lock.ts'
import { runLoop } from '../loop-driver.ts'
import { resolveImproveItemPaths, resolvePaths } from '../paths.ts'
import type {
  CommandRunner,
  PlannedImprovement,
  RetryNowConfig,
  Signal,
} from '../types.ts'

const GREEN: CommandRunner = () => Promise.resolve(0)

class FakeBackend implements AgentBackend {
  readonly calls: PhaseInvocationRequest[] = []
  constructor(
    private readonly execute: (
      request: PhaseInvocationRequest,
    ) => Promise<PhaseRunResult>,
  ) {}
  run(request: PhaseInvocationRequest): Promise<PhaseRunResult> {
    this.calls.push(request)
    return this.execute(request)
  }
}

function config(overrides: Partial<RetryNowConfig> = {}): RetryNowConfig {
  return {
    version: 1,
    agent: 'opencode',
    analysisAgent: 'opencode',
    improveAgent: 'opencode',
    reviewAgent: 'opencode',
    model: '',
    analysisModel: '',
    improveModel: '',
    reviewModel: '',
    modelVariant: '',
    analysisVariant: '',
    improveVariant: '',
    reviewVariant: '',
    agentProfile: '',
    analysis: 'analyze',
    direction: 'improve',
    completion: 'done',
    threshold: 3,
    revertThreshold: 3,
    maxIterations: 1,
    skipPermissions: true,
    commitPerIteration: true,
    verifyEnabled: false,
    verifyTest: '',
    verifyLint: '',
    benchCommand: '',
    benchRuns: 3,
    improvementBatchSize: 2,
    waitForQuota: false,
    quotaPollMs: 10,
    maxQuotaWaitMs: 50,
    targets: [],
    phaseTimeoutMs: 60_000,
    ...overrides,
  }
}

const PLAN: readonly PlannedImprovement[] = [
  { id: '1', title: 'first item' },
  { id: '2', title: 'second item' },
]

async function initRepo(root: string): Promise<void> {
  await runGit(['init'], root)
  // Identity and signing go straight into .git/config instead of three git config spawns. Process
  // creation dominates fixture cost on Windows, and this helper runs for every test in the file.
  await appendFile(
    join(root, '.git', 'config'),
    '[user]\n\temail = test@retry-now.local\n\tname = retry-now test\n[commit]\n\tgpgsign = false\n',
    'utf8',
  )
  await writeFile(join(root, 'one.txt'), 'one base\n')
  await writeFile(join(root, 'two.txt'), 'two base\n')
  await runGit(['add', '.'], root)
  await runGit(['commit', '-m', 'fixture'], root)
}

function analyzeSignal(iteration: number): Signal {
  return {
    iteration,
    phase: 'analyze',
    result: 'improvements_found',
    report: 'r.md',
    nextImprovement: 'first item',
    plannedImprovements: PLAN,
    summary: 'two improvements',
    timestamp: '2026-07-30T00:00:00.000Z',
  }
}

function keptItemSignal(request: PhaseInvocationRequest, file: string): Signal {
  if (request.item === undefined || request.reportPath === undefined) {
    throw new Error('item request metadata is required')
  }
  return {
    iteration: request.iteration,
    phase: 'improve',
    result: 'applied',
    report: request.reportPath,
    plannedCount: 1,
    appliedImprovements: [
      {
        id: request.item.id,
        title: request.item.title,
        status: 'kept',
        impact: `improved by item ${request.item.id}`,
        decisionReason: `independent review verified item ${request.item.id}`,
        files: [file],
      },
    ],
    keptCount: 1,
    revertedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    summary: 'kept',
    timestamp: '2026-07-30T00:00:00.000Z',
  }
}

/**
 * A backend that carries item 1 through implement+review successfully, then hands item 2 the
 * supplied outcome. `FILE_FOR` keeps each item on its own file so attribution stays exact.
 */
const FILE_FOR: Readonly<Record<string, string>> = {
  '1': 'one.txt',
  '2': 'two.txt',
}

function backendFailingItemTwo(
  root: string,
  itemTwoOutcome: () => Promise<PhaseRunResult>,
): FakeBackend {
  const paths = resolvePaths(root)
  return new FakeBackend(async (request) => {
    if (request.phase === 'analyze') {
      await writeJson(paths.signal, analyzeSignal(request.iteration))
      return { kind: 'exit', code: 0 }
    }
    if (
      request.item === undefined ||
      request.itemIndex === undefined ||
      request.stage === undefined
    ) {
      throw new Error('item stage metadata is required')
    }
    if (request.item.id === '2') return itemTwoOutcome()
    const file = FILE_FOR[request.item.id] ?? 'one.txt'
    const artifacts = resolveImproveItemPaths(
      paths,
      request.iteration,
      request.itemIndex,
      request.stage,
      request.item.id,
    )
    if (request.stage === 'implement') {
      await writeFile(join(root, file), `${file} improved\n`)
    }
    await writeJson(artifacts.signal, keptItemSignal(request, file))
    await writeText(artifacts.report, `${request.stage} report for item 1\n`)
    return { kind: 'exit', code: 0 }
  })
}

test('a mid-batch machine failure COMMITS the reviewed prefix and stops with error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-prefix-'))
  const lines: string[] = []
  try {
    await initRepo(root)
    // Item 2 never produces a valid signal, so it exhausts PHASE_ATTEMPTS and reports `failed`.
    const backend = backendFailingItemTwo(root, () =>
      Promise.resolve({ kind: 'exit', code: 1 }),
    )

    const result = await runLoop(config(), {
      cwd: root,
      dryRun: false,
      waitForQuota: false,
      backend,
      commandRunner: GREEN,
      log: (line) => lines.push(line),
    })

    expect(result.status).toBe('error')
    expect(result.iterations).toBe(1)

    // Item 1's reviewed work is durable history, exactly like the hand-recovered `(1/2 applied)`.
    const body = (await runGit(['log', '-1', '--format=%B'], root)).stdout
    expect(body).toContain('retry-now#0001')
    expect(body).toContain('(1/2 applied)')
    expect(body).toContain('first item')
    // Item 2 is recorded as failed with the driver's reason, so history explains the stop.
    expect(body).toContain('second item')
    expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe(
      'one.txt improved\n',
    )
    // Item 2 never landed, and its rollback left the tree clean.
    expect(await readFile(join(root, 'two.txt'), 'utf8')).toBe('two base\n')
    expect((await runGit(['status', '--porcelain'], root)).stdout).toBe('')
    expect(lines.join('\n')).toContain('reviewed prefix')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('a mid-batch quota stop ROLLS BACK the whole iteration instead of keeping a partial plan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-quota-batch-'))
  const lines: string[] = []
  try {
    await initRepo(root)
    const backend = backendFailingItemTwo(root, () =>
      Promise.resolve({ kind: 'quota' }),
    )

    const result = await runLoop(config(), {
      cwd: root,
      dryRun: false,
      waitForQuota: false,
      backend,
      commandRunner: GREEN,
      log: (line) => lines.push(line),
    })

    expect(result.status).toBe('paused-quota')
    // The run will be retried from scratch, so item 1's unrecorded work must NOT survive.
    expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('one base\n')
    expect((await runGit(['status', '--porcelain'], root)).stdout).toBe('')
    expect(
      (await runGit(['rev-list', '--count', 'HEAD'], root)).stdout.trim(),
    ).toBe('1')
    expect(lines.join('\n')).toContain('시작 상태로 복원했습니다')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('an agent commit during an item quarantines HEAD and never resets it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-item-head-'))
  const lines: string[] = []
  try {
    await initRepo(root)
    const paths = resolvePaths(root)
    const backend = new FakeBackend(async (request) => {
      if (request.phase === 'analyze') {
        await writeJson(paths.signal, analyzeSignal(request.iteration))
        return { kind: 'exit', code: 0 }
      }
      // The agent commits, which the per-stage HEAD contract forbids.
      await writeFile(join(root, 'one.txt'), 'agent committed this\n')
      await runGit(['add', 'one.txt'], root)
      await runGit(['commit', '-m', 'rogue agent commit'], root)
      return { kind: 'exit', code: 0 }
    })

    const result = await runLoop(config(), {
      cwd: root,
      dryRun: false,
      waitForQuota: false,
      backend,
      commandRunner: GREEN,
      log: (line) => lines.push(line),
    })

    expect(result.status).toBe('error')
    const quarantine = JSON.parse(
      await readFile(paths.headQuarantine, 'utf8'),
    ) as { source: string; itemId: string }
    expect(quarantine.source).toBe('implement')
    expect(quarantine.itemId).toBe('1')
    // The rogue commit is LEFT alone — never auto-reset.
    expect(
      (await runGit(['rev-list', '--count', 'HEAD'], root)).stdout.trim(),
    ).toBe('2')
    expect(lines.join('\n')).toContain('Git HEAD를 변경했습니다')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('automatic commit mode refuses to start on a dirty target tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-dirty-'))
  const lines: string[] = []
  try {
    await initRepo(root)
    // Pre-existing user work: committing it inside an iteration would misattribute it.
    await writeFile(join(root, 'one.txt'), 'uncommitted user work\n')
    const paths = resolvePaths(root)
    const backend = new FakeBackend(async (request) => {
      await writeJson(paths.signal, analyzeSignal(request.iteration))
      return { kind: 'exit', code: 0 }
    })

    const result = await runLoop(config(), {
      cwd: root,
      dryRun: false,
      waitForQuota: false,
      backend,
      commandRunner: GREEN,
      log: (line) => lines.push(line),
    })

    expect(result.status).toBe('error')
    expect(lines.join('\n')).toContain('깨끗한 대상 워킹트리가 필요합니다')
    // The user's work is untouched.
    expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe(
      'uncommitted user work\n',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('a no-improvement life bumps the streak and converges without any commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-converge-'))
  const lines: string[] = []
  try {
    await initRepo(root)
    const paths = resolvePaths(root)
    const backend = new FakeBackend(async (request) => {
      await writeJson(paths.signal, {
        iteration: request.iteration,
        phase: 'analyze',
        result: 'no_improvements',
        report: 'r.md',
        plannedImprovements: [],
        summary: 'nothing to do',
        timestamp: '2026-07-30T00:00:00.000Z',
      })
      return { kind: 'exit', code: 0 }
    })

    const result = await runLoop(config({ threshold: 2, maxIterations: 9 }), {
      cwd: root,
      dryRun: false,
      waitForQuota: false,
      backend,
      commandRunner: GREEN,
      log: (line) => lines.push(line),
    })

    expect(result.status).toBe('stopped-converged')
    expect(result.iterations).toBe(2)
    expect(result.finalStreak).toBe(2)
    expect(
      (await runGit(['rev-list', '--count', 'HEAD'], root)).stdout.trim(),
    ).toBe('1')
    // The summary a user reads after an unattended run must exist.
    expect(await readFile(paths.summary, 'utf8')).toContain('retry-now')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('a STOP sentinel halts at the next boundary before spawning a life', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-stop-'))
  const lines: string[] = []
  try {
    await initRepo(root)
    const paths = resolvePaths(root)
    const backend = new FakeBackend(() =>
      Promise.resolve({ kind: 'exit', code: 0 }),
    )
    await writeText(paths.stop, '')

    const result = await runLoop(config(), {
      cwd: root,
      dryRun: false,
      waitForQuota: false,
      backend,
      commandRunner: GREEN,
      log: (line) => lines.push(line),
    })

    expect(result.status).toBe('stopped-manual')
    expect(backend.calls).toHaveLength(0) // no life was started at all
    expect(lines.join('\n')).toContain('STOP 감지')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('an already-stopped state refuses to resume and explains how to reset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-already-stopped-'))
  const lines: string[] = []
  try {
    await initRepo(root)
    const paths = resolvePaths(root)
    await writeJson(paths.state, {
      status: 'stopped-converged',
      iteration: 12,
      noImprovementStreak: 3,
      threshold: 3,
      revertStreak: 0,
      revertThreshold: 3,
      startedAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
    })
    const backend = new FakeBackend(() =>
      Promise.resolve({ kind: 'exit', code: 0 }),
    )

    const result = await runLoop(config(), {
      cwd: root,
      dryRun: false,
      waitForQuota: false,
      backend,
      commandRunner: GREEN,
      log: (line) => lines.push(line),
    })

    expect(result.status).toBe('stopped-converged')
    expect(result.iterations).toBe(12)
    expect(backend.calls).toHaveLength(0)
    expect(lines.join('\n')).toContain('state.json 을 삭제')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('a second driver on the SAME project is refused while the first holds the lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-double-'))
  const lines: string[] = []
  try {
    await initRepo(root)
    const paths = resolvePaths(root)
    const backend = new FakeBackend(() =>
      Promise.resolve({ kind: 'exit', code: 0 }),
    )
    // The holder must be genuinely ALIVE and NOT us: a dead pid would be reclaimed as stale, and our
    // own pid short-circuits as our leftover. The parent process satisfies both.
    const livePid = process.ppid
    expect(isPidAlive(livePid)).toBe(true)
    expect(livePid).not.toBe(process.pid)
    await writeJson(paths.driverLock, {
      pid: livePid,
      root,
      startedAt: '2026-07-30T00:00:00.000Z',
    })

    const result = await runLoop(config(), {
      cwd: root,
      dryRun: false,
      waitForQuota: false,
      backend,
      commandRunner: GREEN,
      log: (line) => lines.push(line),
    })

    expect(result.status).toBe('stopped-manual')
    expect(backend.calls).toHaveLength(0)
    expect(lines.join('\n')).toContain(
      '이미 이 프로젝트에서 윤회가 돌고 있습니다',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('the final summary lists every item outcome from the recorded history', async () => {
  // `writeSummary` builds a per-item table from the `appliedImprovements` persisted in history.jsonl.
  // If either side of that contract drifts the table silently disappears from the report a user reads
  // after an unattended overnight run, so it is asserted end to end.
  const root = await mkdtemp(join(tmpdir(), 'retry-now-summary-items-'))
  try {
    await initRepo(root)
    const paths = resolvePaths(root)

    const result = await runLoop(config({ improvementBatchSize: 1 }), {
      cwd: root,
      dryRun: false,
      waitForQuota: false,
      backend: new FakeBackend(async (request) => {
        if (request.phase === 'analyze') {
          await writeJson(paths.signal, {
            ...analyzeSignal(request.iteration),
            plannedImprovements: [PLAN[0]],
          })
          return { kind: 'exit', code: 0 }
        }
        if (
          request.item === undefined ||
          request.itemIndex === undefined ||
          request.stage === undefined
        ) {
          throw new Error('item stage metadata is required')
        }
        const artifacts = resolveImproveItemPaths(
          paths,
          request.iteration,
          request.itemIndex,
          request.stage,
          request.item.id,
        )
        if (request.stage === 'implement') {
          await writeFile(join(root, 'one.txt'), 'one.txt improved\n')
        }
        await writeJson(artifacts.signal, keptItemSignal(request, 'one.txt'))
        await writeText(artifacts.report, 'report\n')
        return { kind: 'exit', code: 0 }
      }),
      commandRunner: GREEN,
      log: () => undefined,
    })

    expect(result.iterations).toBe(1)
    const summary = await readFile(paths.summary, 'utf8')
    expect(summary).toContain(
      '| iter | id | status | model | improvement | reason |',
    )
    expect(summary).toContain('first item')
    expect(summary).toContain('kept')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
