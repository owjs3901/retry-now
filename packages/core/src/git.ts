/**
 * Minimal, injectable git access for the loop driver.
 *
 * The loop deliberately keeps git OUT of the per-item REVERT path — reverts restore from file
 * backups so unrelated working-tree changes are never disturbed. But to hold the "loop end ⇒
 * clean tree" invariant, the driver needs two SURGICAL, non-destructive git actions:
 *   1. commit EXACTLY the newly-attributable files a kept batch produced; and
 *   2. observe whether the tree is clean, so anything left behind can be WARNED about.
 * Nothing here ever discards work: it only stages explicit paths + commits, or reads status.
 *
 * `GitRunner` is injectable so the driver's git use stays unit-testable; the default `runGit`
 * spawns the real `git` (never through a shell).
 */
import { spawn } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { hasUnsafeTextCharacter } from './safe-text.ts'

export { formatIterationCommitMessage } from './commit-message.ts'

export interface GitResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Run one `git` invocation in `cwd`, capturing output. Never throws; never uses a shell. */
export type GitRunner = (
  args: readonly string[],
  cwd: string,
) => Promise<GitResult>

export const runGit: GitRunner = (args, cwd) =>
  new Promise<GitResult>((resolve) => {
    const child = spawn('git', [...args], {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.on('error', (err) => {
      resolve({ code: -1, stdout, stderr: `${stderr}${err.message}` })
    })
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })

/** True only for a bounded, literal, repository-relative file path. */
export function isSafeRepoFilePath(file: string): boolean {
  if (file === '' || file.length > 500 || hasUnsafeTextCharacter(file)) {
    return false
  }
  const normalized = file.replace(/\\/g, '/')
  if (
    normalized === '.' ||
    normalized.startsWith('/') ||
    normalized.endsWith('/') ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.startsWith(':') ||
    ['*', '?', '[', ']', '{', '}'].some((token) => normalized.includes(token))
  ) {
    return false
  }
  const parts = normalized.split('/')
  return parts.every((part) => part !== '' && part !== '.' && part !== '..')
}

function literalPathspec(file: string): string {
  return `:(literal)${file}`
}

/** True only when `cwd` is inside a git work tree — a non-repo project then silently skips git. */
export async function isGitRepo(
  cwd: string,
  git: GitRunner = runGit,
): Promise<boolean> {
  const r = await git(['rev-parse', '--is-inside-work-tree'], cwd)
  return r.code === 0 && r.stdout.trim() === 'true'
}

/** Current commit id, `(unborn)` before the first commit, or null on an unexpected Git failure. */
export async function headRevision(
  cwd: string,
  git: GitRunner = runGit,
): Promise<string | null> {
  const result = await git(['rev-parse', '--verify', 'HEAD'], cwd)
  if (result.code === 0) return result.stdout.trim()
  return result.code === 128 ? '(unborn)' : null
}

/**
 * Porcelain status lines ("XY path"), empty when the tree is clean. An optional `pathspec` scopes
 * the query (e.g. to one monorepo target). `.retry-now/` is gitignored, so it never appears here.
 * A failed status query (e.g. not a repo) yields an empty list rather than throwing.
 */
export async function statusPorcelain(
  cwd: string,
  pathspec: readonly string[] = [],
  git: GitRunner = runGit,
): Promise<string[]> {
  const args = [
    'status',
    '--porcelain',
    ...(pathspec.length > 0 ? ['--', ...pathspec.map(literalPathspec)] : []),
  ]
  const r = await git(args, cwd)
  if (r.code !== 0) return []
  return r.stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line !== '')
}

/** Exact changed file paths from porcelain `-z`; null means Git could not establish attribution. */
export async function statusPaths(
  cwd: string,
  pathspec: readonly string[] = [],
  git: GitRunner = runGit,
): Promise<string[] | null> {
  const args = [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    ...(pathspec.length > 0 ? ['--', ...pathspec.map(literalPathspec)] : []),
  ]
  const result = await git(args, cwd)
  if (result.code !== 0) return null
  const entries = result.stdout.split('\0')
  const files = new Set<string>()
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    if (!entry || entry.length < 4) continue
    const status = entry.slice(0, 2)
    files.add(entry.slice(3))
    if (status.includes('R') || status.includes('C')) {
      const original = entries[index + 1]
      if (original) files.add(original)
      index++
    }
  }
  return [...files]
}

/** Ensure every auto-committed file is newly changed by this IMPROVE phase. */
export function validateCommitFileAttribution(
  files: readonly string[],
  baseline: readonly string[],
  current: readonly string[],
  scope = '',
): string | null {
  const baselineSet = new Set(baseline)
  const currentSet = new Set(current)
  const normalizedScope = scope.replace(/\\/g, '/').replace(/\/$/, '')
  for (const file of files) {
    if (
      normalizedScope !== '' &&
      file !== normalizedScope &&
      !file.startsWith(`${normalizedScope}/`)
    ) {
      return `kept file is outside the configured scope: ${file}`
    }
    if (baselineSet.has(file)) {
      return `kept file was already dirty before IMPROVE: ${file}`
    }
    if (!currentSet.has(file)) {
      return `reported kept file is not an exact changed file: ${file}`
    }
  }
  for (const file of baselineSet) {
    if (!currentSet.has(file))
      return `pre-IMPROVE baseline file disappeared: ${file}`
  }
  const expected = new Set([...baselineSet, ...files])
  for (const file of currentSet) {
    if (!expected.has(file)) return `unreported changed file: ${file}`
  }
  return null
}

/**
 * Stage and commit EXACTLY `files` with `message`, and nothing else. Paths must be safe, literal,
 * repository-relative regular files (a missing path is allowed for deletion). Every add must pass
 * before the pathspec-scoped commit runs, so a partial staging failure cannot produce a commit.
 *
 * On ANY first-commit failure it retries ONCE with `--no-gpg-sign`. In an UNATTENDED loop, landing
 * the kept change matters more than the signature, and the dominant failure — commit signing with
 * no passphrase prompt available (`commit.gpgsign`, GPG/SSH) — must NEVER block or "fail" the
 * iteration; we do not try to pattern-match the error, we just make the change land. A genuinely
 * non-signing failure simply fails again and is reported (the driver warns; it is never fatal).
 * Never throws — the `GitResult` reports what happened.
 */
export async function commitPaths(
  cwd: string,
  files: readonly string[],
  message: string,
  git: GitRunner = runGit,
): Promise<GitResult> {
  if (files.length === 0) {
    return { code: -1, stdout: '', stderr: 'no files supplied for commit' }
  }
  for (const file of files) {
    if (!isSafeRepoFilePath(file)) {
      return {
        code: -1,
        stdout: '',
        stderr: `unsafe repository file path: ${file}`,
      }
    }
    try {
      if ((await lstat(resolve(cwd, file))).isDirectory()) {
        return {
          code: -1,
          stdout: '',
          stderr: `repository path is a directory, not a file: ${file}`,
        }
      }
    } catch {
      // Missing paths can be deletions; any other problem is rejected by the checked git add below.
    }
  }
  const literalFiles = files.map(literalPathspec)
  for (const file of files) {
    const add = await git(['add', '-A', '--', literalPathspec(file)], cwd)
    if (add.code !== 0) return add
  }
  const commit = await git(
    ['commit', '-m', message, '--', ...literalFiles],
    cwd,
  )
  if (commit.code === 0) return commit
  return git(
    ['commit', '--no-gpg-sign', '-m', message, '--', ...literalFiles],
    cwd,
  )
}
