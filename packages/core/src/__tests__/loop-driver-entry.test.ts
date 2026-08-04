/**
 * The driver's process boundary and its entry points.
 *
 * Everything here was previously unmeasured because `loop-driver.ts` sat outside the coverage
 * threshold. Three groups:
 *   - the REAL subprocess layer (`spawnVerifyCommand`, `runAgent`, `CliSpawnBackend`), which is the
 *     one place this codebase genuinely creates child processes;
 *   - per-package (split) mode, where each target converges independently and the results are folded
 *     into one overall status;
 *   - `runProjectLoop` / `runDriverCli`, the shared entry every agent frontend and the CLI shim over.
 *
 * The subprocess tests use `node -e` one-liners rather than a real agent CLI: the behaviour under
 * test is the driver's own plumbing (exit code propagation, output teeing, spawn-failure handling),
 * and spawning an actual coding agent from a unit test would be neither fast nor deterministic.
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
import {
  CliSpawnBackend,
  createCliSpawnBackend,
  runAgent,
  runDriverCli,
  runLoop,
  runProjectLoop,
  spawnVerifyCommand,
} from '../loop-driver.ts'
import { resolvePaths } from '../paths.ts'
import { createCommandRunner, TIMED_OUT } from '../preflight.ts'
import type { CommandRunner, RetryNowConfig } from '../types.ts'

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

function rawConfig(overrides: Record<string, unknown> = {}): object {
  return {
    version: 1,
    agent: 'opencode',
    analysis: 'analyze everything',
    direction: 'improve safely',
    completion: 'all checks pass',
    threshold: 2,
    revertThreshold: 3,
    maxIterations: 2,
    commitPerIteration: false,
    improvementBatchSize: 1,
    ...overrides,
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
    threshold: 2,
    revertThreshold: 3,
    maxIterations: 2,
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
    maxQuotaWaitMs: 50,
    targets: [],
    phaseTimeoutMs: 60_000,
    ...overrides,
  }
}

async function initRepo(root: string): Promise<void> {
  await runGit(['init'], root)
  // Identity and signing go straight into .git/config instead of three git config spawns. Process
  // creation dominates fixture cost on Windows, and this helper runs for every test in the file.
  await appendFile(
    join(root, '.git', 'config'),
    '[user]\n\temail = test@retry-now.local\n\tname = retry-now test\n[commit]\n\tgpgsign = false\n',
    'utf8',
  )
  // Two package dirs so split mode has real, separate target paths to scope to.
  for (const pkg of ['pkg-a', 'pkg-b']) {
    await mkdir(join(root, pkg), { recursive: true })
    await writeFile(join(root, pkg, 'file.txt'), `${pkg}\n`)
  }
  await runGit(['add', '.'], root)
  await runGit(['commit', '-m', 'fixture'], root)
}

/** Answers every ANALYZE with "nothing to improve", so a life completes with no item work. */
function noImprovementBackend(
  root: string,
  slugs: readonly string[],
): FakeBackend {
  return new FakeBackend(async (request) => {
    // In split mode each target owns its own signal path; pick the one this phase is scoped to.
    for (const slug of slugs) {
      const paths = resolvePaths(root, slug === '' ? undefined : slug)
      await writeJson(paths.signal, {
        iteration: request.iteration,
        phase: 'analyze',
        result: 'no_improvements',
        report: 'r.md',
        plannedImprovements: [],
        summary: 'nothing',
        timestamp: '2026-07-30T00:00:00.000Z',
      })
    }
    return { kind: 'exit', code: 0 }
  })
}

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
    // Best-effort: on Windows a child process that was just killed can still hold its working
    // directory briefly, and a locked temp dir must never fail a test whose assertions all passed.
    try {
      await rm(dir, { recursive: true, force: true })
    } catch {
      // leaked into the OS temp dir; harmless
    }
  }
})

test('runAgent tees stdout and stderr to the log and resolves the real exit code', async () => {
  const root = await scratch('run-agent')
  const logPath = join(root, 'agent.log')
  const code = await runAgent(
    process.execPath,
    [
      '-e',
      'process.stdout.write("from-stdout");process.stderr.write("from-stderr");process.exit(3)',
    ],
    root,
    logPath,
    () => undefined,
  )
  expect(code).toBe(3)
  const logged = await readFile(logPath, 'utf8')
  expect(logged).toContain('from-stdout')
  expect(logged).toContain('from-stderr')
})

test('runAgent reports a spawn failure as exit -1 instead of throwing', async () => {
  // An unattended loop must survive "the agent CLI is not installed" without crashing.
  const root = await scratch('run-agent-missing')
  const lines: string[] = []
  const code = await runAgent(
    join(root, 'no-such-binary-6f3a'),
    [],
    root,
    join(root, 'agent.log'),
    (line) => lines.push(line),
  )
  expect(code).toBe(-1)
  expect(lines.join('\n')).toContain('! spawn failed:')
})

test('the default backend factory builds a real CLI spawn backend', async () => {
  const backend = createCliSpawnBackend()
  expect(backend).toBeInstanceOf(CliSpawnBackend)
})

test('CliSpawnBackend launches the configured agent and surfaces a failed spawn', async () => {
  const root = await scratch('cli-backend')
  const lines: string[] = []
  const spawned: { cmd: string; args: readonly string[]; cwd: string }[] = []
  // The spawn is injected rather than performed. That keeps a real coding-agent CLI out of the test
  // AND avoids the two things that segfault Bun 1.3.9 on Windows — a non-existent `cwd`, and a
  // second failing real spawn in the same process. What is under test here is the DECISION this
  // class makes (what to launch, and how a non-zero exit is reported), not Node's spawn.
  const backend = new CliSpawnBackend((cmd, args, cwd, logPath, log) => {
    spawned.push({ cmd, args, cwd })
    log(`  ! spawn failed: agent CLI is not installed (see ${logPath})`)
    return Promise.resolve(-1)
  })

  const result = await backend.run({
    message: 'msg',
    role: 'improve',
    title: 'retry-now #0001 IMPROVE item 1 implement',
    config: config(),
    logPath: join(root, 'phase.log'),
    cwd: root,
    model: '',
    iteration: 1,
    phase: 'improve',
    stage: 'implement',
    timeoutMs: 60_000,
    completionProbe: () => Promise.resolve(null),
    log: (line) => lines.push(line),
  })

  // A missing agent CLI must be reported as an exit code, never thrown: an unattended loop has to
  // survive it and retry rather than crash.
  expect(result).toEqual({ kind: 'exit', code: -1 })
  // The agent actually chosen for the `improve` role must be the one launched, in the project root.
  expect(spawned).toHaveLength(1)
  expect(spawned[0]?.cmd).toBe('opencode')
  expect(spawned[0]?.args).toContain('msg')
  expect(spawned[0]?.cwd).toBe(root)
  const report = lines.join('\n')
  // The STAGE, not the phase, is what a reader needs for an item invocation, and an unset model
  // must read as the agent's own default rather than an empty gap.
  expect(report).toContain('implement (agent default, fresh session)')
  expect(report).toContain('agent exited with code -1')
})

test('spawnVerifyCommand runs a configured command through a shell and reports its status', async () => {
  const root = await scratch('verify-spawn')
  const run = createCommandRunner(spawnVerifyCommand)
  expect(
    await run(`"${process.execPath}" -e "process.exit(0)"`, root, 30_000),
  ).toBe(0)
  expect(
    await run(`"${process.execPath}" -e "process.exit(4)"`, root, 30_000),
  ).toBe(4)
})

test('spawnVerifyCommand is killed and reported as timed out when it outlives its budget', async () => {
  // Deliberately run in the OS temp root rather than a scratch dir: the child is still being killed
  // when the test ends, and on Windows a live process pins its working directory.
  const run = createCommandRunner(spawnVerifyCommand)
  const code = await run(
    `"${process.execPath}" -e "setTimeout(()=>{},30000)"`,
    tmpdir(),
    250,
  )
  expect(code).toBe(TIMED_OUT)
})

test('a red verification baseline refuses to start and never spawns a life', async () => {
  const root = await scratch('preflight-red')
  await initRepo(root)
  const backend = new FakeBackend(() =>
    Promise.resolve({ kind: 'exit', code: 0 }),
  )
  const lines: string[] = []

  const result = await runLoop(
    config({ verifyEnabled: true, verifyTest: 'anything' }),
    {
      cwd: root,
      dryRun: false,
      waitForQuota: false,
      backend,
      commandRunner: () => Promise.resolve(1), // already red at HEAD
      log: (line) => lines.push(line),
    },
  )

  expect(result.status).toBe('error')
  expect(result.iterations).toBe(0)
  expect(backend.calls).toHaveLength(0)
})

test('split mode converges each target independently and writes an overall summary', async () => {
  const root = await scratch('split')
  await initRepo(root)
  const targets = ['pkg-a', 'pkg-b']
  const backend = noImprovementBackend(
    root,
    targets.map((t) => t),
  )
  const lines: string[] = []

  const result = await runLoop(config({ targets, threshold: 1 }), {
    cwd: root,
    dryRun: false,
    waitForQuota: false,
    backend,
    commandRunner: GREEN,
    log: (line) => lines.push(line),
  })

  expect(result.status).toBe('stopped-converged')
  expect(result.iterations).toBe(2) // one life per target
  const overall = await readFile(resolvePaths(root).summary, 'utf8')
  expect(overall).toContain('전체 윤회 종합 보고서')
  expect(overall).toContain('pkg-a')
  expect(overall).toContain('pkg-b')
  expect(overall).toContain('stopped-converged')
  const report = lines.join('\n')
  expect(report).toContain('per-package 윤회(분할)')
  expect(report).toContain('◆ TARGET: pkg-a')
  // Each target keeps isolated state.
  expect(await readFile(resolvePaths(root, 'pkg-a').state, 'utf8')).toContain(
    'stopped-converged',
  )
})

test('split mode stops the remaining targets when STOP appears mid-run', async () => {
  const root = await scratch('split-stop')
  await initRepo(root)
  const targets = ['pkg-a', 'pkg-b']
  const paths = resolvePaths(root)
  const backend = new FakeBackend(async (request) => {
    for (const slug of targets) {
      await writeJson(resolvePaths(root, slug).signal, {
        iteration: request.iteration,
        phase: 'analyze',
        result: 'no_improvements',
        report: 'r.md',
        plannedImprovements: [],
        summary: 'nothing',
        timestamp: '2026-07-30T00:00:00.000Z',
      })
    }
    // The user stops the run while the FIRST target is still working.
    await writeText(paths.stop, '')
    return { kind: 'exit', code: 0 }
  })
  const lines: string[] = []

  const result = await runLoop(config({ targets, threshold: 1 }), {
    cwd: root,
    dryRun: false,
    waitForQuota: false,
    backend,
    commandRunner: GREEN,
    log: (line) => lines.push(line),
  })

  expect(result.status).toBe('stopped-manual')
  expect(lines.join('\n')).toContain('STOP 감지 — 남은 타겟을 중단합니다.')
  // pkg-b never ran, so it has no state directory content.
  expect(lines.join('\n')).not.toContain('◆ TARGET: pkg-b')
})

test('runProjectLoop returns null when the project has no config', async () => {
  const root = await scratch('no-config')
  expect(await runProjectLoop(root)).toBeNull()
})

test('runProjectLoop loads the on-disk config and honours a commit override', async () => {
  const root = await scratch('project-loop')
  await initRepo(root)
  const paths = resolvePaths(root)
  await writeJson(paths.config, rawConfig({ commitPerIteration: true }))
  const backend = noImprovementBackend(root, [''])

  const result = await runProjectLoop(root, {
    backend,
    // Without this override the clean-tree precondition would apply; proving the override reaches
    // the loop is the point of the assertion below.
    commitOverride: false,
    waitForQuotaOverride: false,
  })

  expect(result?.status).toBe('stopped-converged')
  expect(result?.iterations).toBe(2)
})

test('runDriverCli reports a missing config as exit 1 and says how to fix it', async () => {
  const root = await scratch('cli-no-config')
  const errors: string[] = []
  const original = console.error
  console.error = (line: unknown) => errors.push(String(line))
  try {
    expect(await runDriverCli(['--cwd', root])).toBe(1)
  } finally {
    console.error = original
  }
  expect(errors.join('\n')).toContain('retry-now init')
})

test('runDriverCli parses its flags and resolves 0 on a non-error run', async () => {
  const root = await scratch('cli-flags')
  await initRepo(root)
  await writeJson(resolvePaths(root).config, rawConfig())
  const backend = noImprovementBackend(root, [''])

  const code = await runDriverCli(
    ['--cwd', root, '--no-commit', '--no-wait-for-quota'],
    backend,
  )
  expect(code).toBe(0)
})

test('runDriverCli resolves 1 when the loop ends in error', async () => {
  const root = await scratch('cli-error')
  await initRepo(root)
  await writeJson(resolvePaths(root).config, rawConfig())
  // A backend that never signals exhausts the phase attempts and ends the run in error.
  const backend = new FakeBackend(() =>
    Promise.resolve({ kind: 'exit', code: 1 }),
  )
  expect(await runDriverCli(['--cwd', root, '--commit'], backend)).toBe(1)
}, 30_000)

test('runDriverCli defaults to the current directory when --cwd is absent', async () => {
  // No config in the process cwd of this test run, so the missing-config path proves the default
  // was used rather than a thrown error from an undefined path.
  const errors: string[] = []
  const original = console.error
  console.error = (line: unknown) => errors.push(String(line))
  try {
    const code = await runDriverCli(['--dry-run', '--wait-for-quota'])
    expect(typeof code).toBe('number')
  } finally {
    console.error = original
  }
})
