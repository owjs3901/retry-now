/**
 * What the driver does when GIT cannot answer.
 *
 * Every refusal here exists because the loop commits on the user's behalf, unattended. If Git cannot
 * say what changed, what HEAD is, or what the tree looked like before the batch, the driver has no
 * way to prove which files an item actually produced — so it must STOP and leave the work in place
 * rather than commit something it cannot attribute.
 *
 * These branches are unreachable against a healthy repository, so `DriverOptions.git` is injected to
 * fail one specific invocation at a time. The injected runner always delegates to real Git for
 * everything else: the point is to break a single answer, never to simulate Git's semantics.
 */
import { readFileSync } from 'node:fs'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, test } from 'bun:test'

import type {
  AgentBackend,
  PhaseInvocationRequest,
  PhaseRunResult,
} from '../agent-backend.ts'
import { type GitResult, type GitRunner, runGit } from '../git.ts'
import { appendLine, writeJson, writeText } from '../io.ts'
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
    revertThreshold: 5,
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
const FILE_FOR: Readonly<Record<string, string>> = {
  '1': 'one.txt',
  '2': 'two.txt',
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
    try {
      await rm(dir, { recursive: true, force: true })
    } catch {
      // harmless: a temp dir can stay briefly locked on Windows
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
        decisionReason: `verified item ${request.item.id}`,
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

/** Carries every item through implement+review successfully. */
function successfulBackend(root: string): FakeBackend {
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
    await writeText(artifacts.report, 'report\n')
    return { kind: 'exit', code: 0 }
  })
}

/** Item 1 succeeds; item 2 never signals, so the batch ends in a mid-batch machine failure. */
function prefixThenFailureBackend(root: string): FakeBackend {
  const inner = successfulBackend(root)
  return new FakeBackend((request) =>
    request.item?.id === '2'
      ? Promise.resolve({ kind: 'exit', code: 1 })
      : inner.run(request),
  )
}

/**
 * Real Git for everything except the Nth invocation matching `matches`, which fails. The counter
 * matters because the driver asks the same question at several points in one life.
 */
function failNth(
  matches: (args: readonly string[]) => boolean,
  nth: number,
): GitRunner {
  let seen = 0
  return (args, cwd) => {
    if (matches(args)) {
      seen++
      if (seen === nth) {
        return Promise.resolve({ code: 1, stdout: '', stderr: 'injected' })
      }
    }
    return runGit(args, cwd)
  }
}

const isStatusPaths = (args: readonly string[]): boolean =>
  args[0] === 'status' && args.includes('--porcelain=v1')

/**
 * True once the canonical IMPROVE batch signal has been written, which happens after the LAST item
 * stage and before the driver runs its own post-batch checks.
 *
 * The driver and the per-item stage transaction now share one Git invoker, so an injected answer
 * cannot be aimed at the driver by binding alone — the stage's own HEAD contract would see it first
 * and stop the batch earlier. Gating on this file aims the injection in TIME instead: every stage has
 * finished by the time it exists.
 */
function batchSignalWritten(root: string): boolean {
  try {
    const raw = readFileSync(resolvePaths(root).signal, 'utf8')
    return (JSON.parse(raw) as { phase?: string }).phase === 'improve'
  } catch {
    return false
  }
}

test('an unreadable pre-IMPROVE status stops the life before any item runs', async () => {
  const root = await scratch('baseline-status')
  await initRepo(root)
  const lines: string[] = []
  const backend = successfulBackend(root)

  const result = await runLoop(config(), {
    cwd: root,
    dryRun: false,
    waitForQuota: false,
    backend,
    commandRunner: GREEN,
    // The FIRST porcelain query of the life is the pre-IMPROVE baseline.
    git: failNth(isStatusPaths, 1),
    log: (line) => lines.push(line),
  })

  expect(result.status).toBe('error')
  expect(lines.join('\n')).toContain('안전한 귀속을 보장할 수 없습니다')
  // No item was ever started, so nothing was changed.
  expect(backend.calls.filter((c) => c.phase === 'improve')).toHaveLength(0)
}, 30_000)

test('an unreadable HEAD before IMPROVE stops the life', async () => {
  const root = await scratch('baseline-head')
  await initRepo(root)
  const lines: string[] = []

  const result = await runLoop(config(), {
    cwd: root,
    dryRun: false,
    waitForQuota: false,
    backend: successfulBackend(root),
    commandRunner: GREEN,
    // `rev-parse HEAD` is asked while capturing the iteration snapshot; failing every one makes
    // the snapshot itself unavailable, which is the earlier of the two HEAD guards.
    git: (args, cwd) =>
      args[0] === 'rev-parse'
        ? Promise.resolve({ code: 1, stdout: '', stderr: 'injected' })
        : runGit(args, cwd),
    log: (line) => lines.push(line),
  })

  expect(result.status).toBe('error')
  expect(lines.join('\n')).toContain('스냅샷을 만들 수 없습니다')
}, 30_000)

test('a batch whose commit attribution cannot be read leaves the kept work in the tree', async () => {
  const root = await scratch('final-attribution')
  await initRepo(root)
  const lines: string[] = []

  const result = await runLoop(config(), {
    cwd: root,
    dryRun: false,
    waitForQuota: false,
    backend: successfulBackend(root),
    commandRunner: GREEN,
    // Let the baseline succeed, then fail the post-batch attribution query inside the commit.
    git: failNth(isStatusPaths, 2),
    log: (line) => lines.push(line),
  })

  // The life still completes; the commit is refused and reported, never fatal.
  expect(result.iterations).toBe(1)
  const report = lines.join('\n')
  expect(report).toContain('kept work remains uncommitted')
  expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe(
    'one.txt improved\n',
  )
  expect(
    (await runGit(['rev-list', '--count', 'HEAD'], root)).stdout.trim(),
  ).toBe('1')
}, 30_000)

test('a mid-batch failure whose prefix cannot be attributed refuses to commit and preserves the tree', async () => {
  const root = await scratch('prefix-attribution')
  await initRepo(root)
  const lines: string[] = []

  const result = await runLoop(config(), {
    cwd: root,
    dryRun: false,
    waitForQuota: false,
    backend: prefixThenFailureBackend(root),
    commandRunner: GREEN,
    // Baseline (1) succeeds; the reviewed-prefix attribution query (2) fails.
    git: failNth(isStatusPaths, 2),
    log: (line) => lines.push(line),
  })

  expect(result.status).toBe('error')
  const report = lines.join('\n')
  expect(report).toContain('reviewed prefix 커밋 거부')
  expect(report).toContain('저장소를 자동 롤백하지 않았으며')
  // Item 1's reviewed work is preserved for review rather than committed or discarded.
  expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe(
    'one.txt improved\n',
  )
  expect(
    (await runGit(['rev-list', '--count', 'HEAD'], root)).stdout.trim(),
  ).toBe('1')
}, 30_000)

test('a mid-batch failure whose prefix commit fails stops and preserves the residue', async () => {
  const root = await scratch('prefix-commit-fail')
  await initRepo(root)
  const lines: string[] = []

  const result = await runLoop(config(), {
    cwd: root,
    dryRun: false,
    waitForQuota: false,
    backend: prefixThenFailureBackend(root),
    commandRunner: GREEN,
    git: (args, cwd) =>
      args[0] === 'commit'
        ? Promise.resolve({ code: 128, stdout: '', stderr: 'injected' })
        : runGit(args, cwd),
    log: (line) => lines.push(line),
  })

  expect(result.status).toBe('error')
  expect(lines.join('\n')).toContain('reviewed prefix를 커밋하지 못했습니다')
  expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe(
    'one.txt improved\n',
  )
}, 30_000)

test('a mid-batch failure with automatic commit OFF preserves the prefix in the working tree', async () => {
  const root = await scratch('prefix-no-commit')
  await initRepo(root)
  const lines: string[] = []

  const result = await runLoop(config({ commitPerIteration: false }), {
    cwd: root,
    dryRun: false,
    waitForQuota: false,
    backend: prefixThenFailureBackend(root),
    commandRunner: GREEN,
    log: (line) => lines.push(line),
  })

  expect(result.status).toBe('error')
  expect(lines.join('\n')).toContain(
    '자동 커밋이 비활성화되어 reviewed prefix를 워킹트리에 보존했습니다',
  )
  expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe(
    'one.txt improved\n',
  )
}, 30_000)

test('a HEAD that moved between the batch and the commit is quarantined', async () => {
  const root = await scratch('final-head')
  await initRepo(root)
  const paths = resolvePaths(root)
  const lines: string[] = []
  const result = await runLoop(config(), {
    cwd: root,
    dryRun: false,
    waitForQuota: false,
    backend: successfulBackend(root),
    commandRunner: GREEN,
    // Only once every stage has finished — see `batchSignalWritten`. The driver re-reads HEAD one
    // final time as a belt-and-braces check that nothing committed behind its back.
    git: (args, cwd) =>
      batchSignalWritten(root) &&
      args[0] === 'rev-parse' &&
      args.includes('HEAD')
        ? Promise.resolve({
            code: 0,
            stdout: `${'d'.repeat(40)}\n`,
            stderr: '',
          })
        : runGit(args, cwd),
    log: (line) => lines.push(line),
  })

  expect(result.status).toBe('error')
  expect(lines.join('\n')).toContain('Git HEAD가 변경되었습니다')
  const quarantine = JSON.parse(
    await readFile(paths.headQuarantine, 'utf8'),
  ) as {
    source: string
  }
  expect(quarantine.source).toBe('batch')
}, 30_000)

test('a corrupt history line is skipped so the final summary still renders', async () => {
  const root = await scratch('corrupt-history')
  await initRepo(root)
  const paths = resolvePaths(root)
  // A truncated append — exactly what a killed driver can leave behind mid-write.
  await appendLine(paths.history, '{"iteration":1,"phase":"analyze"')
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

  const result = await runLoop(config({ threshold: 1, maxIterations: 9 }), {
    cwd: root,
    dryRun: false,
    waitForQuota: false,
    backend,
    commandRunner: GREEN,
    log: () => undefined,
  })

  expect(result.status).toBe('stopped-converged')
  // The malformed line did not take the summary down with it.
  expect(await readFile(paths.summary, 'utf8')).toContain('retry-now')
}, 30_000)

test('ANALYZE that commits is quarantined as an unauthorized HEAD change', async () => {
  const root = await scratch('analyze-head')
  await initRepo(root)
  const paths = resolvePaths(root)
  const lines: string[] = []
  const backend = new FakeBackend(async (request) => {
    // ANALYZE is read-only AND must not touch HEAD; this one commits.
    await writeFile(join(root, 'one.txt'), 'analyze committed this\n')
    await runGit(['add', 'one.txt'], root)
    await runGit(['commit', '-m', 'rogue analyze commit'], root)
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
  const quarantine = JSON.parse(
    await readFile(paths.headQuarantine, 'utf8'),
  ) as {
    source: string
  }
  expect(quarantine.source).toBe('analyze')
  expect(lines.join('\n')).toContain('자동 reset 없이 격리했습니다')
  // The rogue commit is preserved, never rewritten.
  expect(
    (await runGit(['rev-list', '--count', 'HEAD'], root)).stdout.trim(),
  ).toBe('2')
}, 30_000)

test('a quota wait refuses to retry an item whose repository moved underneath it', async () => {
  const root = await scratch('quota-unsafe-retry')
  await initRepo(root)
  const paths = resolvePaths(root)
  const lines: string[] = []
  const backend = new FakeBackend(async (request) => {
    if (request.phase === 'analyze') {
      await writeJson(paths.signal, analyzeSignal(request.iteration))
      return { kind: 'exit', code: 0 }
    }
    // The item stage hits a quota wall AND leaves a new commit behind, so retrying it would resume
    // against a repository the driver never approved.
    await writeFile(join(root, 'one.txt'), 'item committed this\n')
    await runGit(['add', 'one.txt'], root)
    await runGit(['commit', '-m', 'rogue item commit'], root)
    return { kind: 'quota' }
  })

  const result = await runLoop(config({ maxQuotaWaitMs: 3_600_000 }), {
    cwd: root,
    dryRun: false,
    waitForQuota: true,
    backend,
    commandRunner: GREEN,
    log: (line) => lines.push(line),
  })

  expect(result.status).toBe('error')
  expect(lines.join('\n')).toContain('refusing unsafe retry')
}, 30_000)

/**
 * Item 1 is carried through review; item 2 never signals, so the batch ends in a mid-batch failure.
 * Git answers are rewritten only once the canonical batch signal exists, which is the moment every
 * stage transaction has finished and the driver has begun deciding whether the reviewed prefix is
 * safe to commit. Gating on that — rather than on "item 2 was declared failed" — keeps the injection
 * out of the per-item stage's own guards, which share this same Git invoker.
 */
function afterItemTwoFails(
  root: string,
  rewrite: (args: readonly string[]) => Promise<GitResult> | null,
): { backend: FakeBackend; git: GitRunner } {
  const inner = successfulBackend(root)
  const backend = new FakeBackend((request) =>
    request.item?.id === '2'
      ? Promise.resolve({ kind: 'exit', code: 1 })
      : inner.run(request),
  )
  const git: GitRunner = (args, cwd) => {
    if (batchSignalWritten(root)) {
      const rewritten = rewrite(args)
      if (rewritten !== null) return rewritten
    }
    return runGit(args, cwd)
  }
  return { backend, git }
}

test('a reviewed prefix is refused when the post-failure snapshot is unavailable', async () => {
  const root = await scratch('prefix-snapshot')
  await initRepo(root)
  const lines: string[] = []
  const { backend, git } = afterItemTwoFails(root, (args) =>
    args[0] === 'rev-parse'
      ? Promise.resolve({ code: 1, stdout: '', stderr: 'injected' })
      : null,
  )

  const result = await runLoop(config(), {
    cwd: root,
    dryRun: false,
    waitForQuota: false,
    backend,
    commandRunner: GREEN,
    git,
    log: (line) => lines.push(line),
  })

  expect(result.status).toBe('error')
  expect(lines.join('\n')).toContain('reviewed prefix 커밋 거부')
  expect(
    (await runGit(['rev-list', '--count', 'HEAD'], root)).stdout.trim(),
  ).toBe('1')
}, 30_000)

test('a reviewed prefix is refused when HEAD moved away from the iteration baseline', async () => {
  const root = await scratch('prefix-head-moved')
  await initRepo(root)
  const lines: string[] = []
  const { backend, git } = afterItemTwoFails(root, (args) =>
    args[0] === 'rev-parse' && args.includes('HEAD')
      ? Promise.resolve({ code: 0, stdout: `${'e'.repeat(40)}\n`, stderr: '' })
      : null,
  )

  const result = await runLoop(config(), {
    cwd: root,
    dryRun: false,
    waitForQuota: false,
    backend,
    commandRunner: GREEN,
    git,
    log: (line) => lines.push(line),
  })

  expect(result.status).toBe('error')
  expect(lines.join('\n')).toContain('reviewed prefix 커밋 거부')
}, 30_000)

test('a reviewed prefix is refused when the approved index no longer matches iteration start', async () => {
  const root = await scratch('prefix-index')
  await initRepo(root)
  const lines: string[] = []
  const { backend, git } = afterItemTwoFails(root, (args) =>
    args[0] === 'write-tree'
      ? Promise.resolve({ code: 0, stdout: `${'f'.repeat(40)}\n`, stderr: '' })
      : null,
  )

  const result = await runLoop(config(), {
    cwd: root,
    dryRun: false,
    waitForQuota: false,
    backend,
    commandRunner: GREEN,
    git,
    log: (line) => lines.push(line),
  })

  expect(result.status).toBe('error')
  expect(lines.join('\n')).toContain('reviewed prefix 커밋 거부')
}, 30_000)

test('an ANALYZE mutation the driver cannot restore stops the life with the restore issue', async () => {
  const root = await scratch('analyze-restore-fail')
  await initRepo(root)
  const paths = resolvePaths(root)
  const lines: string[] = []
  let analyzed = false
  const backend = new FakeBackend(async (request) => {
    await writeFile(join(root, 'one.txt'), 'analyze wrote this\n')
    await writeJson(paths.signal, analyzeSignal(request.iteration))
    analyzed = true
    return { kind: 'exit', code: 0 }
  })

  const result = await runLoop(config(), {
    cwd: root,
    dryRun: false,
    waitForQuota: false,
    backend,
    commandRunner: GREEN,
    // `--git-path` resolves the index location, which restoration needs. Failing it only AFTER
    // ANALYZE ran leaves the pre-flight capture intact but makes the restore itself impossible.
    git: (args, cwd) =>
      analyzed && args.includes('--git-path')
        ? Promise.resolve({ code: 1, stdout: '', stderr: 'injected' })
        : runGit(args, cwd),
    log: (line) => lines.push(line),
  })

  expect(result.status).toBe('error')
  expect(lines.join('\n')).toContain('ANALYZE 변경 복원 실패')
}, 30_000)

test('a failed item whose repository cannot be proven refuses to commit the reviewed prefix', async () => {
  const root = await scratch('repo-unknown')
  await initRepo(root)
  const lines: string[] = []
  const inner = successfulBackend(root)
  let reachedItemTwo = false
  const backend = new FakeBackend((request) => {
    if (request.item?.id !== '2') return inner.run(request)
    reachedItemTwo = true
    return Promise.resolve({ kind: 'exit', code: 1 })
  })

  const result = await runLoop(config(), {
    cwd: root,
    dryRun: false,
    waitForQuota: false,
    backend,
    commandRunner: GREEN,
    // From item 2 onward the driver can no longer restore or re-capture, so it cannot prove what
    // state the repository was left in — the one case where it must NOT commit the prefix.
    git: (args, cwd) =>
      reachedItemTwo && args.includes('--git-path')
        ? Promise.resolve({ code: 1, stdout: '', stderr: 'injected' })
        : runGit(args, cwd),
    log: (line) => lines.push(line),
  })

  expect(result.status).toBe('error')
  expect(lines.join('\n')).toContain('reviewed prefix 커밋 거부')
  expect(
    (await runGit(['rev-list', '--count', 'HEAD'], root)).stdout.trim(),
  ).toBe('1')
}, 30_000)

test('an interrupted iteration that cannot be rolled back stops loudly instead of silently resuming', async () => {
  const root = await scratch('rollback-fail')
  await initRepo(root)
  const lines: string[] = []
  const inner = successfulBackend(root)
  let quotaHit = false
  const backend = new FakeBackend((request) => {
    if (request.item?.id !== '2') return inner.run(request)
    quotaHit = true
    return Promise.resolve({ kind: 'quota' })
  })

  // After the quota wall the repository is restored TWICE: the per-item stage returns to its approved
  // snapshot first (3 index-path lookups), then the driver rolls the whole iteration back (2 more).
  // Failing only from the 4th lookup lets the stage restore succeed — so the outcome stays `quota`
  // and reaches the iteration rollback — while the rollback itself cannot complete.
  let indexPathLookups = 0
  const result = await runLoop(config(), {
    cwd: root,
    dryRun: false,
    waitForQuota: false,
    backend,
    commandRunner: GREEN,
    git: (args, cwd) => {
      if (quotaHit && args.includes('--git-path')) {
        indexPathLookups++
        if (indexPathLookups >= 4) {
          return Promise.resolve({ code: 1, stdout: '', stderr: 'injected' })
        }
      }
      return runGit(args, cwd)
    },
    log: (line) => lines.push(line),
  })

  expect(result.status).toBe('error')
  const report = lines.join('\n')
  expect(report).toContain('중단된 IMPROVE 윤회 복원 실패')
  // It must NOT claim the restore succeeded.
  expect(report).not.toContain('시작 상태로 복원했습니다')
}, 30_000)
