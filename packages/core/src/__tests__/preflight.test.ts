/**
 * Baseline preflight — the guard against the loop's most dangerous failure mode.
 *
 * If `verifyLint` is already red at HEAD, every proposed item is reverted for a failure it did not
 * cause, nothing is ever kept, and the run terminates by announcing convergence. That is a SILENT
 * wrong answer: the log says the codebase is perfect when the truth is that the loop never got a
 * single verdict it could trust. These tests pin both the detection and the refusal.
 */
import { expect, test } from 'bun:test'

import {
  type CommandRunner,
  createCommandRunner,
  hasGatingFailure,
  preflightCommands,
  preflightReport,
  type PreflightResult,
  runBaselinePreflight,
  type SpawnCommand,
  type SpawnedCommand,
  TIMED_OUT,
  verifyGatingCommands,
} from '../preflight.ts'
import type { RetryNowConfig } from '../types.ts'

function cfg(overrides: Partial<RetryNowConfig> = {}): RetryNowConfig {
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
    analysis: 'a',
    direction: 'd',
    completion: 'c',
    threshold: 3,
    revertThreshold: 3,
    maxIterations: 10,
    skipPermissions: true,
    commitPerIteration: true,
    verifyEnabled: true,
    verifyTest: 'run tests',
    verifyLint: 'run lint',
    benchCommand: 'run bench',
    benchRuns: 3,
    improvementBatchSize: 4,
    waitForQuota: false,
    quotaPollMs: 1000,
    maxQuotaWaitMs: 10_000,
    targets: [],
    phaseTimeoutMs: 60_000,
    ...overrides,
  }
}

function runner(codes: Readonly<Record<string, number>>): CommandRunner {
  return (command) => Promise.resolve(codes[command] ?? 0)
}

test('collects exactly the configured commands, and none when verification is off', () => {
  expect(preflightCommands(cfg()).map((c) => c.role)).toEqual([
    'test',
    'lint',
    'benchmark',
  ])
  // verifyEnabled gates test+lint but never the benchmark
  expect(
    preflightCommands(cfg({ verifyEnabled: false })).map((c) => c.role),
  ).toEqual(['benchmark'])
  expect(
    preflightCommands(cfg({ verifyEnabled: false, benchCommand: '' })),
  ).toEqual([])
  expect(preflightCommands(cfg({ verifyTest: '' })).map((c) => c.role)).toEqual(
    ['lint', 'benchmark'],
  )
  expect(preflightCommands(cfg({ verifyLint: '' })).map((c) => c.role)).toEqual(
    ['test', 'benchmark'],
  )
})

test('a green baseline produces no report at all', async () => {
  const results = await runBaselinePreflight('/repo', cfg(), runner({}))

  expect(results.every((result) => result.code === 0)).toBe(true)
  expect(hasGatingFailure(results)).toBe(false)
  expect(preflightReport(results)).toBeNull()
})

test('an empty configuration is treated as a trustworthy baseline', async () => {
  const results = await runBaselinePreflight(
    '/repo',
    cfg({ verifyEnabled: false, benchCommand: '' }),
    runner({}),
  )

  expect(results).toEqual([])
  expect(preflightReport(results)).toBeNull()
})

test('a red lint baseline refuses the run and names the false-convergence trap', async () => {
  // This is the reporter's exact situation: a pre-existing clippy warning in a test helper.
  const results = await runBaselinePreflight(
    '/repo',
    cfg(),
    runner({ 'run lint': 1 }),
  )
  const report = preflightReport(results)

  expect(hasGatingFailure(results)).toBe(true)
  expect(report?.join('\n')).toContain('시작 거부')
  expect(report?.join('\n')).toContain('run lint')
  expect(report?.join('\n')).toContain('exit 1')
  // The consequence must be spelled out, not merely implied.
  expect(report?.join('\n')).toContain('맺어졌다')
  expect(report?.join('\n')).toContain('verifyEnabled')
})

test('a red benchmark warns but does not gate', async () => {
  const results = await runBaselinePreflight(
    '/repo',
    cfg(),
    runner({ 'run bench': 2 }),
  )
  const report = preflightReport(results)

  expect(hasGatingFailure(results)).toBe(false)
  expect(report?.join('\n')).toContain('벤치마크')
  expect(report?.join('\n')).toContain('윤회는 계속합니다')
  expect(report?.join('\n')).not.toContain('시작 거부')
})

test('a timed-out command is reported as a timeout rather than an exit status', () => {
  const results: readonly PreflightResult[] = [
    { role: 'test', command: 'hangs forever', gating: true, code: TIMED_OUT },
  ]

  expect(hasGatingFailure(results)).toBe(true)
  expect(preflightReport(results)?.join('\n')).toContain('시간 초과')
  expect(preflightReport(results)?.join('\n')).not.toContain('exit -2')
})

test('the per-item gate returns null when every gating command is green', async () => {
  // Given / When
  const issue = await verifyGatingCommands('/repo', cfg(), runner({}))

  // Then
  expect(issue).toBeNull()
})

test('the per-item gate describes a red lint command', async () => {
  // Given / When
  const issue = await verifyGatingCommands(
    '/repo',
    cfg(),
    runner({ 'run lint': 7 }),
  )

  // Then
  expect(issue).toBe('lint: `run lint` → exit 7')
})

test('the per-item gate never runs or fails on a red benchmark', async () => {
  // Given
  const seen: string[] = []

  // When
  const issue = await verifyGatingCommands('/repo', cfg(), (command) => {
    seen.push(command)
    return Promise.resolve(command === 'run bench' ? 9 : 0)
  })

  // Then
  expect(issue).toBeNull()
  expect(seen).toEqual(['run tests', 'run lint'])
})

test('the per-item gate accepts an explicit choice to configure no gating commands', async () => {
  // Given
  const seen: string[] = []

  // When
  const issue = await verifyGatingCommands(
    '/repo',
    cfg({ verifyEnabled: false }),
    (command) => {
      seen.push(command)
      return Promise.resolve(0)
    },
  )

  // Then
  expect(issue).toBeNull()
  expect(seen).toEqual([])
})

test('the per-item gate renders a timed-out command as a timeout', async () => {
  // Given / When
  const issue = await verifyGatingCommands(
    '/repo',
    cfg({ verifyLint: '' }),
    runner({ 'run tests': TIMED_OUT }),
  )

  // Then
  expect(issue).toBe('test: `run tests` → 시간 초과')
  expect(issue).not.toContain('exit -2')
})

test('every configured command is measured, in order, against the repository root', async () => {
  const seen: string[] = []
  const results = await runBaselinePreflight(
    '/repo/root',
    cfg(),
    (cmd, cwd) => {
      seen.push(`${cmd}@${cwd}`)
      return Promise.resolve(0)
    },
  )

  expect(seen).toEqual([
    'run tests@/repo/root',
    'run lint@/repo/root',
    'run bench@/repo/root',
  ])
  expect(results).toHaveLength(3)
})

type Listeners = {
  error?: (error: Error) => void
  close?: (code: number | null) => void
}

/**
 * A child process that never actually exists. The real spawn is exercised once, at the bottom of
 * this file; everything about timing and failure handling is proven here, where no process is
 * created and none has to be killed.
 */
function fakeSpawn(script: (listeners: Listeners) => void): {
  readonly spawn: SpawnCommand
  readonly killed: () => number
} {
  let kills = 0
  return {
    spawn: () => {
      const listeners: Listeners = {}
      queueMicrotask(() => script(listeners))
      return {
        on: (event: 'error' | 'close', listener: never) => {
          listeners[event] = listener
        },
        kill: () => {
          kills += 1
        },
      } as SpawnedCommand
    },
    killed: () => kills,
  }
}

test('a command that exits reports its status, and a null status reads as failure', async () => {
  const clean = fakeSpawn((l) => l.close?.(0))
  const broken = fakeSpawn((l) => l.close?.(3))
  // A child killed by a signal reports a null code; that is not success.
  const signalled = fakeSpawn((l) => l.close?.(null))

  expect(await createCommandRunner(clean.spawn)('c', '/repo', 5_000)).toBe(0)
  expect(await createCommandRunner(broken.spawn)('c', '/repo', 5_000)).toBe(3)
  expect(await createCommandRunner(signalled.spawn)('c', '/repo', 5_000)).toBe(
    -1,
  )
})

test('a command that cannot be spawned resolves instead of rejecting', async () => {
  // A preflight that threw would abort the loop before it could explain why — the exact opposite
  // of this module's purpose. The baseline verdict must always be reportable.
  const missing = fakeSpawn((l) => l.error?.(new Error('ENOENT')))

  expect(await createCommandRunner(missing.spawn)('c', '/repo', 5_000)).toBe(-1)
})

test('a command that outlives its budget is killed and reported as timed out', async () => {
  const hanging = fakeSpawn(() => undefined)

  expect(await createCommandRunner(hanging.spawn)('c', '/repo', 25)).toBe(
    TIMED_OUT,
  )
  expect(hanging.killed()).toBe(1)
})

test('a late event after the outcome is already settled is ignored', async () => {
  // Killing a child makes it emit `close` right after the timeout already resolved. Without the
  // settled guard that second event would resolve a second time and hide the timeout.
  const late = fakeSpawn((l) => {
    setTimeout(() => l.close?.(0), 40)
  })

  expect(await createCommandRunner(late.spawn)('c', '/repo', 15)).toBe(
    TIMED_OUT,
  )
})
