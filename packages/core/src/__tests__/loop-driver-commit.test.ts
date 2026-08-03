/**
 * `reconcileKeptCommit` — the driver's commit decision.
 *
 * This is the function that turns a reviewed batch into Git history, and every refusal it can return
 * is a case where kept work is deliberately LEFT in the working tree rather than committed wrongly.
 * It stages only the exact files the signal names as kept, never `git add -A`, so a bug here either
 * loses attribution or sweeps unrelated user changes into a retry-now commit.
 *
 * `git` is injected so the two "Git could not answer" refusals — which are unreachable with a healthy
 * repository — are exercised deterministically instead of being left to chance.
 */
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import { type GitResult, type GitRunner, runGit } from '../git.ts'
import { reconcileKeptCommit } from '../loop-driver.ts'
import { type Paths, resolvePaths } from '../paths.ts'
import type { RetryNowConfig, Signal } from '../types.ts'

let root: string
let paths: Paths
const logged: string[] = []
const log = (line: string): void => {
  logged.push(line)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'retry-now-commit-'))
  paths = resolvePaths(root)
  logged.length = 0
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A repository with one commit, so HEAD exists and files can be tracked. */
async function initRepo(): Promise<void> {
  await runGit(['init'], root)
  // Written straight into .git/config instead of three `git config` spawns: process creation
  // dominates test cost on Windows and this fixture runs for every case in the file.
  await appendFile(
    join(root, '.git', 'config'),
    '[user]\n\temail = test@retry-now.local\n\tname = retry-now test\n[commit]\n\tgpgsign = false\n',
    'utf8',
  )
  await writeFile(join(root, 'tracked.txt'), 'base\n', 'utf8')
  await runGit(['add', '.'], root)
  await runGit(['commit', '-m', 'base'], root)
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
    maxIterations: 10,
    skipPermissions: true,
    commitPerIteration: true,
    verifyEnabled: false,
    verifyTest: '',
    verifyLint: '',
    benchCommand: '',
    benchRuns: 3,
    improvementBatchSize: 2,
    waitForQuota: false,
    quotaPollMs: 1000,
    maxQuotaWaitMs: 10_000,
    targets: [],
    phaseTimeoutMs: 60_000,
    ...overrides,
  }
}

/** A batch signal that kept `files`, or kept nothing when `files` is empty. */
function signal(files: readonly string[], keptTitle = 'kept item'): Signal {
  const kept = files.length > 0
  return {
    iteration: 7,
    phase: 'improve',
    result: kept ? 'applied' : 'applied_reverted',
    report: 'r.md',
    plannedCount: 2,
    appliedImprovements: [
      {
        id: '1',
        title: keptTitle,
        status: kept ? 'kept' : 'reverted',
        impact: 'measurable improvement',
        decisionReason: 'independently verified',
        files: [...files],
      },
      {
        id: '2',
        title: 'second item',
        status: 'reverted',
        impact: 'attempted',
        decisionReason: 'regressed the benchmark',
        files: [],
      },
    ],
    keptCount: kept ? 1 : 0,
    revertedCount: kept ? 1 : 2,
    failedCount: 0,
    skippedCount: 0,
    summary: 'batch',
    timestamp: '2026-07-30T00:00:00.000Z',
  }
}

/** Wrap the real git, overriding only the invocations a test wants to fail. */
function failingGit(
  matches: (args: readonly string[]) => boolean,
  result: GitResult = { code: 1, stdout: '', stderr: 'boom' },
): GitRunner {
  return (args, cwd) =>
    matches(args) ? Promise.resolve(result) : runGit(args, cwd)
}

test('commitPerIteration off short-circuits before touching Git at all', async () => {
  let invoked = false
  const outcome = await reconcileKeptCommit(
    paths,
    config({ commitPerIteration: false }),
    7,
    signal(['tracked.txt']),
    [],
    '',
    log,
    () => {
      invoked = true
      return Promise.resolve({ code: 0, stdout: '', stderr: '' })
    },
  )
  expect(outcome.kind).toBe('disabled-by-config')
  expect(invoked).toBe(false)
  expect(logged).toEqual([])
})

test('a batch that kept nothing reports nothing-to-commit, not a refusal', async () => {
  // A fully reverted batch is a NORMAL outcome of the loop, so it must not read as a failure.
  const outcome = await reconcileKeptCommit(
    paths,
    config(),
    7,
    signal([]),
    [],
    '',
    log,
  )
  expect(outcome.kind).toBe('nothing-to-commit')
  expect(logged).toEqual([])
})

test('a kept item naming no files is REFUSED as unattributable', async () => {
  const sig: Signal = {
    ...signal([]),
    result: 'applied',
    appliedImprovements: [
      {
        id: '1',
        title: 'kept but silent',
        status: 'kept',
        impact: 'i',
        decisionReason: 'd',
        files: [],
      },
    ],
    plannedCount: 1,
    keptCount: 1,
    revertedCount: 0,
  }
  const outcome = await reconcileKeptCommit(
    paths,
    config(),
    7,
    sig,
    [],
    '',
    log,
  )
  expect(outcome.kind).toBe('refused')
  if (outcome.kind !== 'refused') return
  expect(outcome.reason).toBe(
    'kept outcomes did not identify attributable files',
  )
})

test('a project that is not a Git repository is REFUSED', async () => {
  const outcome = await reconcileKeptCommit(
    paths,
    config(),
    7,
    signal(['tracked.txt']),
    [],
    '',
    log,
  )
  expect(outcome.kind).toBe('refused')
  if (outcome.kind !== 'refused') return
  expect(outcome.reason).toBe('project root is not a Git repository')
})

test('an unavailable pre-IMPROVE baseline is REFUSED and logged', async () => {
  // `null` means the driver could not read git status BEFORE the batch, so it cannot prove which
  // files this batch actually introduced. Committing anyway could sweep in pre-existing work.
  await initRepo()
  const outcome = await reconcileKeptCommit(
    paths,
    config(),
    7,
    signal(['tracked.txt']),
    null,
    '',
    log,
  )
  expect(outcome.kind).toBe('refused')
  if (outcome.kind !== 'refused') return
  expect(outcome.reason).toBe(
    'could not establish the pre-IMPROVE dirty-file baseline',
  )
  expect(logged.join('\n')).toContain('! commit:')
})

test('an unreadable current status is REFUSED and logged', async () => {
  await initRepo()
  const outcome = await reconcileKeptCommit(
    paths,
    config(),
    7,
    signal(['tracked.txt']),
    [],
    '',
    log,
    failingGit((args) => args.includes('--porcelain=v1')),
  )
  expect(outcome.kind).toBe('refused')
  if (outcome.kind !== 'refused') return
  expect(outcome.reason).toBe(
    'could not establish exact changed-file attribution',
  )
  expect(logged.join('\n')).toContain('! commit:')
})

test('a kept file that is not actually changed is REFUSED as unsafe attribution', async () => {
  // The signal claims a file the working tree does not show as modified — the driver must not
  // fabricate a commit for work it cannot see.
  await initRepo()
  const outcome = await reconcileKeptCommit(
    paths,
    config(),
    7,
    signal(['tracked.txt']),
    [],
    '',
    log,
  )
  expect(outcome.kind).toBe('refused')
  if (outcome.kind !== 'refused') return
  expect(outcome.reason).toContain('not an exact changed file')
  expect(logged.join('\n')).toContain('unsafe attribution')
})

test('commits exactly the kept files and reports the applied share', async () => {
  await initRepo()
  await writeFile(join(root, 'tracked.txt'), 'improved\n', 'utf8')
  const outcome = await reconcileKeptCommit(
    paths,
    config(),
    7,
    signal(['tracked.txt'], 'Tighten the hot loop'),
    [],
    '',
    log,
  )
  expect(outcome.kind).toBe('committed')
  if (outcome.kind !== 'committed') return
  expect(outcome.keptCount).toBe(1)
  expect(outcome.plannedCount).toBe(2)
  expect(outcome.fileCount).toBe(1)

  const body = (await runGit(['log', '-1', '--format=%B'], root)).stdout
  expect(body).toContain('retry-now#0007')
  expect(body).toContain('(1/2 applied)')
  expect(body).toContain('Tighten the hot loop')
  // The reverted item's reason belongs in history too, so a later reader knows why it was dropped.
  expect(body).toContain('regressed the benchmark')
  expect((await runGit(['status', '--porcelain'], root)).stdout).toBe('')
  expect(logged.join('\n')).toContain('✓ commit:')
})

test('a Git commit failure is REFUSED, non-fatal, and leaves the work in the tree', async () => {
  // An unattended loop must never wedge on a commit problem: it reports and keeps going.
  await initRepo()
  await writeFile(join(root, 'tracked.txt'), 'improved\n', 'utf8')
  const outcome = await reconcileKeptCommit(
    paths,
    config(),
    7,
    signal(['tracked.txt']),
    [],
    '',
    log,
    failingGit((args) => args[0] === 'commit', {
      code: 128,
      stdout: '',
      stderr: 'commit blocked',
    }),
  )
  expect(outcome.kind).toBe('refused')
  if (outcome.kind !== 'refused') return
  expect(outcome.reason).toBe('git exit 128')
  expect(logged.join('\n')).toContain('left in the working tree for review')
  // Still uncommitted, so the next run can see and reconcile it.
  expect((await runGit(['status', '--porcelain'], root)).stdout).toContain(
    'tracked.txt',
  )
})

test('plannedCount falls back to the outcome list when the signal omits it', async () => {
  await initRepo()
  await writeFile(join(root, 'tracked.txt'), 'improved\n', 'utf8')
  const base = signal(['tracked.txt'])
  const { plannedCount: _omitted, ...withoutPlannedCount } = base
  const outcome = await reconcileKeptCommit(
    paths,
    config(),
    7,
    withoutPlannedCount,
    [],
    '',
    log,
  )
  expect(outcome.kind).toBe('committed')
  if (outcome.kind !== 'committed') return
  expect(outcome.plannedCount).toBe(2) // derived from appliedImprovements.length
})

test('scoped mode refuses a kept file outside the configured target path', async () => {
  await initRepo()
  await writeFile(join(root, 'tracked.txt'), 'improved\n', 'utf8')
  const outcome = await reconcileKeptCommit(
    paths,
    config({ targets: ['crates/core'] }),
    7,
    signal(['tracked.txt']),
    [],
    'crates/core',
    log,
  )
  expect(outcome.kind).toBe('refused')
  if (outcome.kind !== 'refused') return
  expect(outcome.reason).toContain('outside the configured scope')
})
