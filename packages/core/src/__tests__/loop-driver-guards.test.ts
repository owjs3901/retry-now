/**
 * The driver's refusal and recovery branches.
 *
 * Each test here pins a decision the loop makes when something is WRONG — a quota wall, an ANALYZE
 * phase that mutated the repository it was supposed to only read, an unreadable quarantine marker, a
 * batch that kept nothing. These are the paths that decide whether an unattended overnight run stops
 * honestly or corrupts state, and none of them were measured while `loop-driver.ts` sat outside the
 * coverage threshold.
 */
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, test } from 'bun:test'

import type {
  AgentBackend,
  PhaseInvocationRequest,
  PhaseRunResult,
} from '../agent-backend.ts'
import { runGit } from '../git.ts'
import { writeJson, writeText } from '../io.ts'
import { fmtDuration, runLoop } from '../loop-driver.ts'
import {
  resolveImproveItemPaths,
  resolvePaths,
  slugifyTarget,
} from '../paths.ts'
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
    revertThreshold: 1,
    maxIterations: 1,
    skipPermissions: true,
    commitPerIteration: false,
    verifyEnabled: false,
    verifyTest: '',
    verifyLint: '',
    benchCommand: '',
    benchRuns: 3,
    improvementBatchSize: 1,
    waitForQuota: false,
    quotaPollMs: 10,
    maxQuotaWaitMs: 10_000,
    targets: [],
    phaseTimeoutMs: 60_000,
    ...overrides,
  }
}

const PLAN: readonly PlannedImprovement[] = [{ id: '1', title: 'only item' }]

const dirs: string[] = []
async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `retry-now-${prefix}-`))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir === undefined) continue
    try {
      await rm(dir, { recursive: true, force: true })
    } catch {
      // a just-killed child can still pin its cwd on Windows; leaking a temp dir is harmless
    }
  }
})

async function initRepo(root: string): Promise<void> {
  await runGit(['init'], root)
  // Identity and signing go straight into .git/config instead of three git config spawns. Process
  // creation dominates fixture cost on Windows, and this helper runs for every test in the file.
  await appendFile(
    join(root, '.git', 'config'),
    '[user]\n\temail = test@retry-now.local\n\tname = retry-now test\n[commit]\n\tgpgsign = false\n',
    'utf8',
  )
  await writeFile(join(root, 'one.txt'), 'base\n')
  await runGit(['add', '.'], root)
  await runGit(['commit', '-m', 'fixture'], root)
}

function analyzeSignal(iteration: number): Signal {
  return {
    iteration,
    phase: 'analyze',
    result: 'improvements_found',
    report: 'r.md',
    nextImprovement: 'only item',
    plannedImprovements: PLAN,
    summary: 'one improvement',
    timestamp: '2026-07-30T00:00:00.000Z',
  }
}

function itemSignal(
  request: PhaseInvocationRequest,
  status: 'kept' | 'reverted',
): Signal {
  if (request.item === undefined || request.reportPath === undefined) {
    throw new Error('item request metadata is required')
  }
  const kept = status === 'kept'
  return {
    iteration: request.iteration,
    phase: 'improve',
    result: kept ? 'applied' : 'applied_reverted',
    report: request.reportPath,
    plannedCount: 1,
    appliedImprovements: [
      {
        id: request.item.id,
        title: request.item.title,
        status,
        impact: 'attempted change',
        decisionReason: kept ? 'verified' : 'regressed the benchmark',
        files: kept ? ['one.txt'] : [],
      },
    ],
    keptCount: kept ? 1 : 0,
    revertedCount: kept ? 0 : 1,
    failedCount: 0,
    skippedCount: 0,
    summary: status,
    timestamp: '2026-07-30T00:00:00.000Z',
  }
}

test('an invalid ANALYZE signal is rejected with the reason and retried in a fresh session', async () => {
  const root = await scratch('invalid-signal')
  await initRepo(root)
  const paths = resolvePaths(root)
  const lines: string[] = []
  const backend = new FakeBackend(async (request) => {
    // `improvements_found` with an EMPTY plan violates the analyze contract.
    await writeJson(paths.signal, {
      iteration: request.iteration,
      phase: 'analyze',
      result: 'improvements_found',
      report: 'r.md',
      plannedImprovements: [],
      summary: 'contradictory',
      timestamp: '2026-07-30T00:00:00.000Z',
    })
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
  const report = lines.join('\n')
  expect(report).toContain('invalid structured signal (attempt 1/3)')
  expect(report).toContain('plannedImprovements must contain at least one item')
  // The rejection reason is fed back so the retry can act on it rather than repeating blindly.
  const retried = backend.calls.filter((call) => call.phase === 'analyze')
  expect(retried).toHaveLength(3)
  expect(retried[1]?.message).toContain('PREVIOUS ATTEMPT REJECTED')
}, 30_000)

test('waitForQuota pauses immediately when the wait budget is already spent', async () => {
  const root = await scratch('quota-deadline')
  await initRepo(root)
  const lines: string[] = []
  const backend = new FakeBackend(() => Promise.resolve({ kind: 'quota' }))

  const result = await runLoop(
    // A zero budget means the deadline has passed on the first check.
    config({ maxQuotaWaitMs: 0, quotaPollMs: 90_000 }),
    {
      cwd: root,
      dryRun: false,
      waitForQuota: true,
      backend,
      commandRunner: GREEN,
      log: (line) => lines.push(line),
    },
  )

  expect(result.status).toBe('paused-quota')
  expect(lines.join('\n')).toContain('동안 회복되지 않음 → paused-quota')
  expect(backend.calls).toHaveLength(1) // no pointless retries against a spent budget
}, 30_000)

test('waitForQuota waits and resumes the SAME life without spending a crash attempt', async () => {
  const root = await scratch('quota-resume')
  await initRepo(root)
  const paths = resolvePaths(root)
  const lines: string[] = []
  let quotaWalls = 2
  const backend = new FakeBackend(async (request) => {
    if (quotaWalls > 0) {
      quotaWalls--
      return { kind: 'quota' }
    }
    await writeJson(paths.signal, {
      iteration: request.iteration,
      phase: 'analyze',
      result: 'no_improvements',
      report: 'r.md',
      plannedImprovements: [],
      summary: 'nothing',
      timestamp: '2026-07-30T00:00:00.000Z',
    })
    return { kind: 'exit', code: 0 }
  })

  const result = await runLoop(
    config({ threshold: 1, maxQuotaWaitMs: 3_600_000, quotaPollMs: 10 }),
    {
      cwd: root,
      dryRun: false,
      waitForQuota: true,
      backend,
      commandRunner: GREEN,
      log: (line) => lines.push(line),
    },
  )

  // Two quota walls did NOT burn the 3-attempt crash budget: the life still completed.
  expect(result.status).toBe('stopped-converged')
  expect(backend.calls).toHaveLength(3)
  expect(lines.join('\n')).toContain('대기 후 재시도')
}, 30_000)

test('fmtDuration renders each scale a wait log can report', () => {
  // Exercised directly because the hour and minute scales are only reachable through a real wait of
  // that length — a test that slept for them would be worthless.
  expect(fmtDuration(6_000)).toBe('6s')
  expect(fmtDuration(90_000)).toBe('2m')
  expect(fmtDuration(21_600_000)).toBe('6.0h')
  expect(fmtDuration(3_600_000)).toBe('1.0h')
  expect(fmtDuration(59_999)).toBe('60s')
})

test('a STOP sentinel written during a quota wait ends the wait immediately', async () => {
  const root = await scratch('quota-stop')
  await initRepo(root)
  const paths = resolvePaths(root)
  const backend = new FakeBackend(async () => {
    await writeText(paths.stop, '')
    return { kind: 'quota' }
  })

  const result = await runLoop(config({ maxQuotaWaitMs: 3_600_000 }), {
    cwd: root,
    dryRun: false,
    waitForQuota: true,
    backend,
    commandRunner: GREEN,
    log: () => undefined,
  })

  expect(result.status).toBe('paused-quota')
  expect(backend.calls).toHaveLength(1)
}, 30_000)

test('ANALYZE that mutates the repository is restored and the life stops', async () => {
  const root = await scratch('analyze-mutation')
  await initRepo(root)
  const paths = resolvePaths(root)
  const lines: string[] = []
  const backend = new FakeBackend(async (request) => {
    // ANALYZE is contractually read-only; this one edits a tracked file.
    await writeFile(join(root, 'one.txt'), 'analyze wrote this\n')
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
  expect(lines.join('\n')).toContain('시작 상태로 복원하고 중단했습니다')
  // Restored, so the rogue edit did not leak into the next life's baseline.
  expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('base\n')
}, 30_000)

test('an unreadable HEAD quarantine blocks the run and refuses to guess', async () => {
  const root = await scratch('quarantine-garbage')
  await initRepo(root)
  const paths = resolvePaths(root)
  const lines: string[] = []
  await writeText(paths.headQuarantine, '{ not valid json')
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

  expect(result.status).toBe('error')
  expect(backend.calls).toHaveLength(0)
  expect(lines.join('\n')).toContain('HEAD quarantine is unreadable')
}, 30_000)

test('a batch that keeps nothing climbs the revert streak to convergence', async () => {
  const root = await scratch('revert-converge')
  await initRepo(root)
  const paths = resolvePaths(root)
  const lines: string[] = []
  const backend = new FakeBackend(async (request) => {
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
    const artifacts = resolveImproveItemPaths(
      paths,
      request.iteration,
      request.itemIndex,
      request.stage,
      request.item.id,
    )
    // The implementer proposes, the reviewer rejects: a normal, healthy outcome.
    await writeJson(
      artifacts.signal,
      itemSignal(request, request.stage === 'implement' ? 'kept' : 'reverted'),
    )
    await writeText(artifacts.report, 'report\n')
    if (request.stage === 'implement') {
      await writeFile(join(root, 'one.txt'), 'candidate\n')
    } else {
      await writeFile(join(root, 'one.txt'), 'base\n') // reviewer restored the backup
    }
    return { kind: 'exit', code: 0 }
  })

  const result = await runLoop(
    config({ revertThreshold: 1, maxIterations: 5 }),
    {
      cwd: root,
      dryRun: false,
      waitForQuota: false,
      backend,
      commandRunner: GREEN,
      log: (line) => lines.push(line),
    },
  )

  expect(result.status).toBe('stopped-converged')
  const report = lines.join('\n')
  expect(report).toContain('보존된 변경 없음')
  expect(report).toContain('리버트 streak = 1/1')
  expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('base\n')
}, 30_000)

test('a killed previous run with a clean tree reports nothing left to recover', async () => {
  const root = await scratch('interrupted-clean')
  await initRepo(root)
  const paths = resolvePaths(root)
  const lines: string[] = []
  await writeJson(paths.state, {
    status: 'running',
    iteration: 4,
    noImprovementStreak: 0,
    threshold: 3,
    revertStreak: 0,
    revertThreshold: 1,
    startedAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
  })
  await writeJson(paths.driverLock, {
    pid: 999_999,
    root,
    startedAt: '2026-07-30T00:00:00.000Z',
  })
  const backend = new FakeBackend(async (request) => {
    await writeJson(paths.signal, {
      iteration: request.iteration,
      phase: 'analyze',
      result: 'no_improvements',
      report: 'r.md',
      plannedImprovements: [],
      summary: 'nothing',
      timestamp: '2026-07-30T00:00:00.000Z',
    })
    return { kind: 'exit', code: 0 }
  })

  await runLoop(config({ threshold: 1, maxIterations: 9 }), {
    cwd: root,
    dryRun: false,
    waitForQuota: false,
    backend,
    commandRunner: GREEN,
    log: (line) => lines.push(line),
  })

  const report = lines.join('\n')
  expect(report).toContain('status running → interrupted')
  // No residue, so the user must NOT be sent to `recover` for nothing.
  expect(report).toContain('워킹트리가 깨끗합니다')
  expect(report).not.toContain('retry-now recover')
}, 30_000)

test('a stale lock over an already-terminal state has nothing to correct', async () => {
  const root = await scratch('interrupted-terminal')
  await initRepo(root)
  const paths = resolvePaths(root)
  const lines: string[] = []
  await writeJson(paths.state, {
    status: 'paused-quota',
    iteration: 4,
    noImprovementStreak: 0,
    threshold: 3,
    revertStreak: 0,
    revertThreshold: 1,
    startedAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
  })
  await writeJson(paths.driverLock, {
    pid: 999_999,
    root,
    startedAt: '2026-07-30T00:00:00.000Z',
  })
  const backend = new FakeBackend(async (request) => {
    await writeJson(paths.signal, {
      iteration: request.iteration,
      phase: 'analyze',
      result: 'no_improvements',
      report: 'r.md',
      plannedImprovements: [],
      summary: 'nothing',
      timestamp: '2026-07-30T00:00:00.000Z',
    })
    return { kind: 'exit', code: 0 }
  })

  await runLoop(config({ threshold: 1, maxIterations: 9 }), {
    cwd: root,
    dryRun: false,
    waitForQuota: false,
    backend,
    commandRunner: GREEN,
    log: (line) => lines.push(line),
  })

  expect(lines.join('\n')).toContain('이미 종료 상태를 기록했습니다')
}, 30_000)

test('the driver logs to the console when no log sink is supplied', async () => {
  // Every other test injects `log`, so the default sink — what a real `retry-now run` actually uses —
  // would otherwise never execute.
  const root = await scratch('default-log')
  await initRepo(root)
  const paths = resolvePaths(root)
  const captured: string[] = []
  const original = console.log
  console.log = (line: unknown) => captured.push(String(line))
  try {
    await runLoop(config({ threshold: 1, maxIterations: 1 }), {
      cwd: root,
      dryRun: false,
      waitForQuota: false,
      backend: new FakeBackend(async (request) => {
        await writeJson(paths.signal, {
          iteration: request.iteration,
          phase: 'analyze',
          result: 'no_improvements',
          report: 'r.md',
          plannedImprovements: [],
          summary: 'nothing',
          timestamp: '2026-07-30T00:00:00.000Z',
        })
        return { kind: 'exit', code: 0 }
      }),
      commandRunner: GREEN,
    })
  } finally {
    console.log = original
  }
  expect(captured.join('\n')).toContain('retry-now')
}, 30_000)

test('a backend can probe for the phase signal the driver is waiting on', async () => {
  // `completionProbe` is how the in-process opencode backend decides a child session is really done
  // (session.idle fires too early). A spawning backend never calls it, so it needs exercising here.
  const root = await scratch('completion-probe')
  await initRepo(root)
  const paths = resolvePaths(root)
  const probes: (string | null)[] = []
  const backend = new FakeBackend(async (request) => {
    // The driver must always hand a backend this probe; a missing one would silently make the
    // assertions below vacuous, so it is a hard failure rather than an optional-chain.
    const { completionProbe } = request
    if (completionProbe === undefined) {
      throw new Error(
        'the driver must supply completionProbe to every invocation',
      )
    }
    // Before the signal exists the probe must report nothing to read.
    probes.push((await completionProbe())?.result ?? null)
    await writeJson(paths.signal, {
      iteration: request.iteration,
      phase: 'analyze',
      result: 'no_improvements',
      report: 'r.md',
      plannedImprovements: [],
      summary: 'nothing',
      timestamp: '2026-07-30T00:00:00.000Z',
    })
    // After it is written the probe must see the terminal signal.
    probes.push((await completionProbe())?.result ?? null)
    return { kind: 'exit', code: 0 }
  })

  const result = await runLoop(config({ threshold: 1, maxIterations: 1 }), {
    cwd: root,
    dryRun: false,
    waitForQuota: false,
    backend,
    commandRunner: GREEN,
    log: () => undefined,
  })

  expect(result.status).toBe('stopped-converged')
  expect(probes).toEqual([null, 'no_improvements'])
}, 30_000)

test('a killed per-package run marks every target interrupted, not just the repo root', async () => {
  const root = await scratch('interrupted-targets')
  await initRepo(root)
  await mkdir(join(root, 'pkg-a'), { recursive: true })
  await writeFile(join(root, 'pkg-a', 'file.txt'), 'pkg-a\n')
  await runGit(['add', '.'], root)
  await runGit(['commit', '-m', 'pkg'], root)

  const paths = resolvePaths(root)
  const targetPaths = resolvePaths(root, slugifyTarget('pkg-a'))
  const lines: string[] = []
  await writeJson(targetPaths.state, {
    status: 'running',
    iteration: 9,
    noImprovementStreak: 0,
    threshold: 3,
    revertStreak: 0,
    revertThreshold: 1,
    startedAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
  })
  await writeJson(paths.driverLock, {
    pid: 999_999,
    root,
    startedAt: '2026-07-30T00:00:00.000Z',
  })

  await runLoop(
    config({ targets: ['pkg-a'], threshold: 1, maxIterations: 9 }),
    {
      cwd: root,
      dryRun: false,
      waitForQuota: false,
      backend: new FakeBackend(async (request) => {
        await writeJson(targetPaths.signal, {
          iteration: request.iteration,
          phase: 'analyze',
          result: 'no_improvements',
          report: 'r.md',
          plannedImprovements: [],
          summary: 'nothing',
          timestamp: '2026-07-30T00:00:00.000Z',
        })
        return { kind: 'exit', code: 0 }
      }),
      commandRunner: GREEN,
      log: (line) => lines.push(line),
    },
  )

  // The correction must reach the TARGET's state file, which is where a split run's truth lives.
  expect(lines.join('\n')).toContain('status running → interrupted')
  expect(lines.join('\n')).toContain('targets')
}, 30_000)
