/**
 * `@retry-now/core` git helpers — the driver's surgical, non-destructive git access.
 *
 * These back the "loop end ⇒ clean tree" guarantee: `commitPaths` lets the driver commit EXACTLY
 * the newly-attributable files a kept batch produced (never a blanket add), and
 * `statusPorcelain` lets it observe residue to WARN about. The happy paths run against a REAL temp
 * git repo (matching the io/config test style); the failure/branch paths use an injected fake
 * `GitRunner` so signing-retry and error handling are exercised deterministically.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, expect, test } from 'bun:test'

import {
  commitPaths,
  formatIterationCommitMessage,
  type GitRunner,
  headRevision,
  isGitRepo,
  isSafeRepoFilePath,
  runGit,
  statusPaths,
  statusPorcelain,
  validateCommitFileAttribution,
} from '../git.ts'
import type { Signal } from '../types.ts'

let repo: string

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), 'retry-now-git-'))
  await runGit(['init'], repo)
  await runGit(['config', 'user.email', 'test@retry-now.local'], repo)
  await runGit(['config', 'user.name', 'retry-now test'], repo)
  await runGit(['config', 'commit.gpgsign', 'false'], repo)
})

afterAll(async () => {
  await rm(repo, { recursive: true, force: true })
})

test('runGit: a successful command resolves code 0 with stdout', async () => {
  const r = await runGit(['--version'], repo)
  expect(r.code).toBe(0)
  expect(r.stdout.toLowerCase()).toContain('git version')
})

test('runGit: an unknown subcommand resolves non-zero with stderr', async () => {
  const r = await runGit(['definitely-not-a-real-subcommand'], repo)
  expect(r.code).not.toBe(0)
  expect(r.stderr.length).toBeGreaterThan(0)
})

test('runGit: a spawn failure (missing cwd) resolves code -1 and never throws', async () => {
  const r = await runGit(['--version'], join(repo, 'no', 'such', 'dir'))
  expect(r.code).toBe(-1)
})

test('isGitRepo: true inside a repo, false outside one', async () => {
  expect(await isGitRepo(repo)).toBe(true)
  const bare = await mkdtemp(join(tmpdir(), 'retry-now-nogit-'))
  try {
    expect(await isGitRepo(bare)).toBe(false)
  } finally {
    await rm(bare, { recursive: true, force: true })
  }
})

test('statusPorcelain: [] on a clean tree, lists changes, and scopes by pathspec', async () => {
  expect(await statusPorcelain(repo)).toEqual([])

  await writeFile(join(repo, 'a.txt'), 'hello\n')
  await mkdir(join(repo, 'sub'), { recursive: true })
  await writeFile(join(repo, 'sub', 'b.txt'), 'world\n')

  const all = await statusPorcelain(repo)
  expect(all.some((l) => l.endsWith('a.txt'))).toBe(true)
  expect(all.some((l) => l.includes('sub'))).toBe(true)

  const scoped = await statusPorcelain(repo, ['sub'])
  expect(scoped.length).toBeGreaterThan(0)
  expect(scoped.every((l) => l.includes('sub'))).toBe(true)
  expect(scoped.some((l) => l.endsWith('a.txt'))).toBe(false)
})

test('statusPorcelain: a failed query yields [] (never throws)', async () => {
  const failing: GitRunner = () =>
    Promise.resolve({ code: 1, stdout: '', stderr: 'boom' })
  expect(await statusPorcelain(repo, [], failing)).toEqual([])
})

test('statusPaths: returns exact changed files and parses NUL-delimited names', async () => {
  expect((await statusPaths(repo))?.sort()).toEqual(['a.txt', 'sub/b.txt'])
})

test('validateCommitFileAttribution rejects baseline collisions, omissions, and scope escapes', () => {
  expect(
    validateCommitFileAttribution(
      ['packages/core/src/a.ts'],
      [],
      ['packages/core/src/a.ts'],
      'packages/core',
    ),
  ).toBeNull()
  expect(
    validateCommitFileAttribution(['src/a.ts'], ['src/a.ts'], ['src/a.ts']),
  ).toContain('already dirty')
  expect(validateCommitFileAttribution(['src/a.ts'], [], [])).toContain(
    'not an exact changed file',
  )
  expect(
    validateCommitFileAttribution(
      ['packages/other/a.ts'],
      [],
      ['packages/other/a.ts'],
      'packages/core',
    ),
  ).toContain('outside the configured scope')
  expect(
    validateCommitFileAttribution(
      ['src/a.ts'],
      [],
      ['src/a.ts', 'src/stray.ts'],
    ),
  ).toContain('unreported changed file')
  expect(
    validateCommitFileAttribution(['src/a.ts'], ['src/user.ts'], ['src/a.ts']),
  ).toContain('baseline file disappeared')
})

test('commitPaths: commits EXACTLY the given files, leaving other changes untouched', async () => {
  const beforeHead = await headRevision(repo)
  const res = await commitPaths(
    repo,
    ['a.txt'],
    'retry-now#0001: commit a.txt only',
  )
  expect(res.code).toBe(0)
  expect(beforeHead).toBe('(unborn)')
  expect(await headRevision(repo)).toMatch(/^[0-9a-f]{40,64}$/)

  const after = await statusPorcelain(repo)
  expect(after.some((l) => l.endsWith('a.txt'))).toBe(false) // committed → gone from status
  expect(after.some((l) => l.includes('sub'))).toBe(true) // sub/b.txt left untracked, untouched
})

test('commitPaths: a failed first commit (e.g. signing) is retried once with --no-gpg-sign', async () => {
  const calls: string[][] = []
  const fake: GitRunner = (args) => {
    calls.push([...args])
    if (args[0] === 'commit' && !args.includes('--no-gpg-sign')) {
      return Promise.resolve({
        code: 128,
        stdout: '',
        stderr: 'error: gpg failed to sign the data',
      })
    }
    return Promise.resolve({ code: 0, stdout: '', stderr: '' })
  }
  const res = await commitPaths('/x', ['f.txt'], 'msg', fake)
  expect(res.code).toBe(0)
  expect(
    calls.some((c) => c[0] === 'commit' && c.includes('--no-gpg-sign')),
  ).toBe(true)
})

test('commitPaths: retries with --no-gpg-sign on ANY commit failure and returns the retry result', async () => {
  const commits: string[][] = []
  const fake: GitRunner = (args) => {
    if (args[0] !== 'commit') {
      return Promise.resolve({ code: 0, stdout: '', stderr: '' })
    }
    commits.push([...args])
    // A NON-signing first failure must STILL be retried without signing (unattended = land it).
    return args.includes('--no-gpg-sign')
      ? Promise.resolve({ code: 7, stdout: '', stderr: 'retry also failed' })
      : Promise.resolve({
          code: 1,
          stdout: '',
          stderr: 'some unrelated commit problem',
        })
  }
  const res = await commitPaths('/x', ['f.txt'], 'msg', fake)
  expect(commits.length).toBe(2) // retried even though it was not a signing failure
  expect(commits[1]?.includes('--no-gpg-sign')).toBe(true)
  expect(res.code).toBe(7) // the retry's result is what is returned
})

test('commitPaths: rejects Git magic, traversal, absolute paths, and directories', async () => {
  expect(isSafeRepoFilePath('src/file.ts')).toBe(true)
  expect(isSafeRepoFilePath(':(top)**')).toBe(false)
  expect(isSafeRepoFilePath('../secret.txt')).toBe(false)
  expect(isSafeRepoFilePath('C:\\secret.txt')).toBe(false)
  expect(isSafeRepoFilePath('.')).toBe(false)

  const calls: string[][] = []
  const fake: GitRunner = (args) => {
    calls.push([...args])
    return Promise.resolve({ code: 0, stdout: '', stderr: '' })
  }
  const result = await commitPaths('/repo', [':(top)**'], 'message', fake)

  expect(result.code).toBe(-1)
  expect(calls).toEqual([])
})

test('formatIterationCommitMessage strips controls and bounds agent-authored text', () => {
  const long = `secret\u0000\u001b[31m\u202Espoof ${'x'.repeat(20_000)}`
  const signal: Signal = {
    iteration: 1,
    phase: 'improve',
    result: 'applied',
    report: 'r',
    plannedCount: 1,
    appliedImprovements: [
      {
        id: '1\nforged',
        title: long,
        status: 'kept',
        impact: long,
        decisionReason: long,
        files: ['src/file.ts'],
      },
    ],
    keptCount: 1,
    summary: 's',
    timestamp: 't',
  }

  const message = formatIterationCommitMessage('0001', signal)

  expect(message.length).toBeLessThan(2_000)
  expect(message).not.toContain('\u0000')
  expect(message).not.toContain('\u001b')
  expect(message).not.toContain('\u202e')
  expect(message).not.toContain('forged')
})

test('formatIterationCommitMessage: reports applied/planned and explains every decision', () => {
  const signal: Signal = {
    iteration: 26,
    phase: 'improve',
    result: 'applied',
    report: '.retry-now/reports/0026-improve.md',
    plannedCount: 7,
    appliedImprovements: [
      ...Array.from({ length: 5 }, (_, index) => ({
        id: String(index + 1),
        title:
          index === 1 ? 'dedupe env-var literal' : `kept item ${index + 1}`,
        status: 'kept' as const,
        impact:
          index === 1
            ? 'reduces repeated allocations'
            : 'improves code quality',
        ...(index === 1 ? { metricDelta: '-2.8% median runtime' } : {}),
        decisionReason:
          index === 1
            ? 'benchmark improved beyond observed noise'
            : 'checks stayed green',
      })),
      {
        id: '6',
        title: 'replace path lookup with linear scan',
        status: 'reverted',
        impact: 'attempted to reduce code size',
        metricDelta: '+8.1% median runtime',
        decisionReason:
          'benchmark regressed beyond the noise band; rolled back',
      },
      {
        id: '7',
        title: 'merge wire buffers',
        status: 'skipped',
        impact: 'would remove one temporary buffer',
        decisionReason: 'invalidated by item 5 ownership constraints',
      },
    ],
    keptCount: 5,
    revertedCount: 1,
    failedCount: 0,
    skippedCount: 1,
    summary: 'Five of seven improvements were retained.',
    timestamp: '2026-07-14T00:00:00.000Z',
  }

  const message = formatIterationCommitMessage('0026', signal)

  expect(message).toContain('(5/7 applied)')
  expect(message).toContain('Applied (5/7):')
  expect(message).toContain(
    '[2] dedupe env-var literal — impact: reduces repeated allocations; evidence: -2.8% median runtime; decision: benchmark improved beyond observed noise',
  )
  expect(message).toContain('Not applied (2/7):')
  expect(message).toContain(
    '[6] replace path lookup with linear scan — reverted; attempted impact: attempted to reduce code size; evidence: +8.1% median runtime; reason: benchmark regressed beyond the noise band; rolled back',
  )
  expect(message).toContain(
    '[7] merge wire buffers — skipped; attempted impact: would remove one temporary buffer; reason: invalidated by item 5 ownership constraints',
  )
})

test('commitPaths: preserves the detailed iteration message in real git history', async () => {
  const file = 'detailed.txt'
  await writeFile(join(repo, file), 'detailed commit\n')
  const signal: Signal = {
    iteration: 27,
    phase: 'improve',
    result: 'applied',
    report: 'r',
    plannedCount: 2,
    appliedImprovements: [
      {
        id: '1',
        title: 'speed hot path',
        status: 'kept',
        impact: 'reduces request latency',
        metricDelta: '-4.2% p50',
        decisionReason: 'improvement exceeded benchmark noise',
        files: [file],
      },
      {
        id: '2',
        title: 'compact fallback',
        status: 'reverted',
        impact: 'attempted to reduce binary size',
        metricDelta: '+6.0% p50',
        decisionReason: 'runtime regressed; rolled back',
      },
    ],
    summary: 'one kept, one reverted',
    timestamp: '2026-07-14T00:00:00.000Z',
  }

  const result = await commitPaths(
    repo,
    [file],
    formatIterationCommitMessage('0027', signal),
  )
  const log = await runGit(['log', '-1', '--pretty=%B'], repo)

  expect(result.code).toBe(0)
  expect(log.stdout).toContain('(1/2 applied)')
  expect(log.stdout).toContain('Applied (1/2):')
  expect(log.stdout).toContain('Not applied (1/2):')
  expect(log.stdout).toContain('runtime regressed; rolled back')
})
