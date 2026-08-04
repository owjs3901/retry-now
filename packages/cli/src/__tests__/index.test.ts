import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  type LoopState,
  resolvePaths,
  type RetryNowConfig,
  slugifyTarget,
} from '@retry-now/core'
import { expect, test } from 'bun:test'

import {
  type CliCommands,
  cmdRecover,
  cmdReset,
  cmdRun,
  cmdStatus,
  describeState,
  exists,
  main,
  parseArgs,
  readState,
  runCliEntry,
  type RunDependencies,
} from '../index.ts'

const TARGETS = ['packages/a', 'packages/b'] as const

function config(overrides: Partial<RetryNowConfig> = {}): RetryNowConfig {
  return {
    version: 1,
    agent: 'opencode',
    analysisAgent: 'opencode',
    improveAgent: 'codex',
    reviewAgent: 'claude',
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
    direction: 'improve safely',
    completion: 'verified',
    threshold: 4,
    revertThreshold: 2,
    maxIterations: 9,
    skipPermissions: true,
    commitPerIteration: false,
    verifyEnabled: false,
    verifyTest: '',
    verifyLint: '',
    benchCommand: '',
    benchRuns: 5,
    improvementBatchSize: 2,
    waitForQuota: false,
    quotaPollMs: 1_000,
    maxQuotaWaitMs: 10_000,
    targets: [],
    phaseTimeoutMs: 1_800_000,
    ...overrides,
  }
}

function state(status: LoopState['status'] = 'running'): LoopState {
  return {
    status,
    iteration: 3,
    noImprovementStreak: 1,
    threshold: 4,
    revertStreak: 0,
    revertThreshold: 2,
    startedAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:01:00.000Z',
  }
}

function captureConsole(): {
  readonly logs: string[]
  readonly errors: string[]
  readonly restore: () => void
} {
  const logs: string[] = []
  const errors: string[] = []
  const originalLog = console.log
  const originalError = console.error
  console.log = (message?: unknown) => logs.push(String(message))
  console.error = (message?: unknown) => errors.push(String(message))
  return {
    logs,
    errors,
    restore: () => {
      console.log = originalLog
      console.error = originalError
    },
  }
}

test('parseArgs resolves command flags and positional install target', () => {
  const parsed = parseArgs([
    'install',
    'claude',
    '--cwd',
    'project',
    '--dry-run',
    '--no-commit',
    '--commit',
    '--wait-for-quota',
    '--no-wait-for-quota',
    '--personal',
    '--unknown',
  ])

  expect(parsed).toEqual({
    command: 'install',
    target: 'claude',
    cwd: 'project',
    dryRun: true,
    commitOverride: true,
    waitForQuotaOverride: false,
    personal: true,
  })
})

test('parseArgs keeps defaults when cwd has no following value', () => {
  const parsed = parseArgs(['run', '--cwd'])

  expect(parsed.command).toBe('run')
  expect(parsed.target).toBe('')
  expect(parsed.cwd).toBe(process.cwd())
  expect(parsed.commitOverride).toBeUndefined()
  expect(parsed.waitForQuotaOverride).toBeUndefined()
})

test('file helpers report missing, valid, and malformed state files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-cli-state-'))
  const path = join(root, 'state.json')
  try {
    expect(await exists(path)).toBe(false)
    expect(await readState(path)).toBeNull()
    await writeFile(path, JSON.stringify(state('stopped-converged')))
    expect(await exists(path)).toBe(true)
    expect((await readState(path))?.status).toBe('stopped-converged')
    await writeFile(path, '{ malformed')
    expect(await readState(path)).toBeNull()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('describeState distinguishes ordinary, recoverable, and resolved interruption states', () => {
  expect(
    describeState(null, 4, {
      pendingTransaction: false,
      driverKilled: false,
    }),
  ).toBe('(아직 실행된 적 없음)')
  expect(
    describeState(state(), 4, {
      pendingTransaction: false,
      driverKilled: false,
    }),
  ).toBe('running  iter=3  streak=1/4')
  expect(
    describeState(state(), 4, {
      pendingTransaction: true,
      driverKilled: true,
    }),
  ).toContain('retry-now recover')
  expect(
    describeState(state('interrupted'), 4, {
      pendingTransaction: false,
      driverKilled: false,
    }),
  ).toContain('retry-now run')
})

test('cmdRun refuses missing config in a non-interactive process', async () => {
  const output = captureConsole()
  const dependencies: RunDependencies = {
    loadConfig: async () => null,
    runInit: async () => 0,
    runLoop: async () => ({
      status: 'stopped-converged',
      iterations: 1,
      finalStreak: 4,
      threshold: 4,
    }),
    stdinIsTTY: false,
  }
  try {
    expect(await cmdRun('.', false, undefined, undefined, dependencies)).toBe(1)
    expect(output.errors[0]).toContain('retry-now init')
  } finally {
    output.restore()
  }
})

test('cmdRun propagates interactive init cancellation and missing post-init config', async () => {
  let initCode = 130
  const dependencies: RunDependencies = {
    loadConfig: async () => null,
    runInit: async () => initCode,
    runLoop: async () => ({
      status: 'stopped-converged',
      iterations: 0,
      finalStreak: 0,
      threshold: 4,
    }),
    stdinIsTTY: true,
  }
  const output = captureConsole()
  try {
    expect(await cmdRun('.', false, undefined, undefined, dependencies)).toBe(
      130,
    )
    initCode = 0
    expect(await cmdRun('.', false, undefined, undefined, dependencies)).toBe(1)
    expect(output.logs).toHaveLength(2)
  } finally {
    output.restore()
  }
})

test('cmdRun applies per-run overrides and maps loop status to an exit code', async () => {
  const loaded = config({ commitPerIteration: false, waitForQuota: true })
  const observed: { commit?: boolean; wait?: boolean } = {}
  let status: LoopState['status'] = 'error'
  const dependencies: RunDependencies = {
    loadConfig: async () => loaded,
    runInit: async () => 0,
    runLoop: async (received, options) => {
      observed.commit = received.commitPerIteration
      observed.wait = options.waitForQuota
      return { status, iterations: 1, finalStreak: 0, threshold: 4 }
    },
    stdinIsTTY: false,
  }

  expect(await cmdRun('.', true, undefined, undefined, dependencies)).toBe(1)
  expect(observed).toEqual({ commit: false, wait: true })
  status = 'stopped-converged'
  expect(await cmdRun('.', true, true, false, dependencies)).toBe(0)
  expect(observed).toEqual({ commit: true, wait: false })
})

test('reset restarts every configured package loop before clearing quarantine', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-cli-reset-'))
  const paths = resolvePaths(root)
  try {
    await mkdir(paths.dir, { recursive: true })
    await writeFile(
      paths.config,
      `${JSON.stringify({
        version: 1,
        agent: 'opencode',
        analysis: 'analyze',
        direction: 'improve safely',
        completion: 'verified',
        threshold: 4,
        revertThreshold: 2,
        targets: TARGETS,
      })}\n`,
    )
    for (const target of TARGETS) {
      const targetPaths = resolvePaths(root, slugifyTarget(target))
      await mkdir(join(targetPaths.dir, 'targets', slugifyTarget(target)), {
        recursive: true,
      })
      await writeFile(
        targetPaths.state,
        '{"status":"stopped-converged","iteration":9}\n',
      )
      await writeFile(targetPaths.iterationRecord, '{}\n')
    }
    await writeFile(paths.stop, '')
    await writeFile(paths.headQuarantine, '{}\n')

    const code = await cmdReset(root)

    expect(code).toBe(0)
    for (const target of TARGETS) {
      const targetPaths = resolvePaths(root, slugifyTarget(target))
      const state = await readFile(targetPaths.state, 'utf8')
      expect(state).toContain('"status": "running"')
      expect(state).toContain('"iteration": 0')
      expect(state).toContain('"threshold": 4')
      expect(state).toContain('"revertThreshold": 2')
      expect(await Bun.file(targetPaths.iterationRecord).exists()).toBe(false)
    }
    expect(await Bun.file(paths.stop).exists()).toBe(false)
    expect(await Bun.file(paths.headQuarantine).exists()).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reset rejects a project without config and resets a whole-repo state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-cli-reset-'))
  const output = captureConsole()
  try {
    expect(await cmdReset(root)).toBe(1)
    expect(output.errors[0]).toContain('retry-now init')
    const paths = resolvePaths(root)
    await mkdir(paths.dir, { recursive: true })
    await writeFile(paths.config, `${JSON.stringify(config())}\n`)
    expect(await cmdReset(root)).toBe(0)
    expect((await readState(paths.state))?.iteration).toBe(0)
  } finally {
    output.restore()
    await rm(root, { recursive: true, force: true })
  }
})

test('status reports missing config and a live whole-repository driver', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-cli-status-'))
  const output = captureConsole()
  try {
    expect(await cmdStatus(root)).toBe(1)
    const paths = resolvePaths(root)
    await mkdir(paths.dir, { recursive: true })
    await writeFile(
      paths.config,
      `${JSON.stringify(config({ benchCommand: 'bun bench' }))}\n`,
    )
    await writeFile(paths.state, `${JSON.stringify(state())}\n`)
    await writeFile(paths.stop, '')
    await writeFile(paths.headQuarantine, '{}\n')
    await writeFile(
      paths.driverLock,
      `${JSON.stringify({
        pid: process.pid,
        root,
        startedAt: '2026-07-30T00:00:00.000Z',
      })}\n`,
    )

    expect(await cmdStatus(root)).toBe(0)
    const text = output.logs.join('\n')
    expect(text).toContain('STOP       : sentinel')
    expect(text).toContain('HEAD       : unauthorized commit')
    expect(text).toContain('실행 중')
    expect(text).toContain('bun bench (×5)')
    expect(text).toContain('전체 레포 단일 윤회')
  } finally {
    output.restore()
    await rm(root, { recursive: true, force: true })
  }
})

test('status marks a dead driver and reports every package target state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-cli-status-'))
  const output = captureConsole()
  const targets = ['packages/a', 'packages/b'] as const
  try {
    const paths = resolvePaths(root)
    await mkdir(paths.dir, { recursive: true })
    await writeFile(paths.config, `${JSON.stringify(config({ targets }))}\n`)
    await writeFile(
      paths.driverLock,
      `${JSON.stringify({
        pid: 999_999,
        root,
        startedAt: '2026-07-30T00:00:00.000Z',
      })}\n`,
    )
    const first = resolvePaths(root, slugifyTarget(targets[0]))
    await mkdir(dirname(first.state), { recursive: true })
    await writeFile(first.state, `${JSON.stringify(state('interrupted'))}\n`)
    await writeFile(first.iterationRecord, '{}\n')

    expect(await cmdStatus(root)).toBe(0)
    const text = output.logs.join('\n')
    expect(text).toContain('죽음 (stale lock)')
    expect(text).toContain('패키지별 분할 (2 타겟)')
    expect(text).toContain('retry-now recover')
    expect(text).toContain('packages/b: (아직 실행된 적 없음)')
  } finally {
    output.restore()
    await rm(root, { recursive: true, force: true })
  }
})

test('status treats a missing driver lock as a killed running driver', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-cli-status-'))
  const output = captureConsole()
  try {
    const paths = resolvePaths(root)
    await mkdir(paths.dir, { recursive: true })
    await writeFile(paths.config, `${JSON.stringify(config())}\n`)
    await writeFile(paths.state, `${JSON.stringify(state())}\n`)

    expect(await cmdStatus(root)).toBe(0)
    expect(output.logs.join('\n')).toContain('복구할 중단 배치 없음')
  } finally {
    output.restore()
    await rm(root, { recursive: true, force: true })
  }
})

test('recover prints report lines and summarizes kept and rolled-back items', async () => {
  const output = captureConsole()
  try {
    const code = await cmdRecover('.', async () => ({
      code: 0,
      reports: [
        {
          status: 'recovered',
          target: null,
          iteration: 3,
          keptCount: 2,
          plannedCount: 3,
          rolledBack: ['3'],
          committed: true,
          reason: null,
          lines: ['recovered root'],
        },
        {
          status: 'recovered',
          target: 'packages/a',
          iteration: 2,
          keptCount: 1,
          plannedCount: 1,
          rolledBack: [],
          committed: true,
          reason: null,
          lines: ['recovered package'],
        },
      ],
    }))

    expect(code).toBe(0)
    expect(output.logs.join('\n')).toContain('recovered root')
    expect(output.logs.join('\n')).toContain('리뷰 통과 3건 보존')
    expect(output.logs.join('\n')).toContain('미리뷰 item 3 롤백')
  } finally {
    output.restore()
  }
})

test('recover returns a refusal code without a completion summary', async () => {
  const output = captureConsole()
  try {
    expect(
      await cmdRecover('.', async () => ({
        code: 1,
        reports: [
          {
            status: 'refused',
            target: null,
            iteration: null,
            keptCount: 0,
            plannedCount: 0,
            rolledBack: [],
            committed: false,
            reason: 'unsafe',
            lines: ['refused'],
          },
        ],
      })),
    ).toBe(1)
    expect(output.logs.join('\n')).not.toContain('복구 완료:')
  } finally {
    output.restore()
  }
})

test('main routes every command and reports version, help, and unknown commands', async () => {
  const calls: string[] = []
  const commands: CliCommands = {
    init: async (cwd) => {
      calls.push(`init:${cwd}`)
      return 10
    },
    run: async (cwd, dryRun, commit, wait) => {
      calls.push(`run:${cwd}:${dryRun}:${String(commit)}:${String(wait)}`)
      return 11
    },
    install: async (_entry, target, cwd, personal) => {
      calls.push(`install:${target}:${cwd}:${personal}`)
      return 12
    },
    status: async (cwd) => {
      calls.push(`status:${cwd}`)
      return 13
    },
    recover: async (cwd) => {
      calls.push(`recover:${cwd}`)
      return 14
    },
    reset: async (cwd) => {
      calls.push(`reset:${cwd}`)
      return 15
    },
  }
  const output = captureConsole()
  try {
    expect(await main(['--version'], commands)).toBe(0)
    expect(await main(['-v'], commands)).toBe(0)
    expect(await main(['version'], commands)).toBe(0)
    expect(await main(['init', '--cwd', 'root'], commands)).toBe(10)
    expect(
      await main(
        ['run', '--cwd', 'root', '--dry-run', '--commit', '--wait-for-quota'],
        commands,
      ),
    ).toBe(11)
    expect(
      await main(['install', 'codex', '--cwd', 'root', '--personal'], commands),
    ).toBe(12)
    expect(await main(['status', '--cwd', 'root'], commands)).toBe(13)
    expect(await main(['recover', '--cwd', 'root'], commands)).toBe(14)
    expect(await main(['reset', '--cwd', 'root'], commands)).toBe(15)
    expect(await main([], commands)).toBe(0)
    expect(await main(['help'], commands)).toBe(0)
    expect(await main(['unknown'], commands)).toBe(1)
    expect(calls).toEqual([
      'init:root',
      'run:root:true:true:true',
      'install:codex:root:true',
      'status:root',
      'recover:root',
      'reset:root',
    ])
    expect(output.errors.join('\n')).toContain('알 수 없는 명령: unknown')
    expect(output.logs.join('\n')).toContain('usage:')
  } finally {
    output.restore()
  }
})

test('runCliEntry exits with the returned code and converts failures to exit 1', async () => {
  const exits: number[] = []
  const output = captureConsole()
  try {
    await runCliEntry(
      async () => 7,
      (code) => exits.push(code),
    )
    await runCliEntry(
      async () => {
        throw new Error('entry failed')
      },
      (code) => exits.push(code),
    )
    await runCliEntry(
      async () => {
        throw 'string failure'
      },
      (code) => exits.push(code),
    )
    expect(exits).toEqual([7, 1, 1])
    expect(output.errors.join('\n')).toContain('entry failed')
    expect(output.errors.join('\n')).toContain('string failure')
  } finally {
    output.restore()
  }
})
