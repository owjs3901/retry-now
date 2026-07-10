/**
 * Minimal, injectable git access for the loop driver.
 *
 * The loop deliberately keeps git OUT of the per-item REVERT path — reverts restore from file
 * backups so unrelated working-tree changes are never disturbed. But to hold the "loop end ⇒
 * clean tree" invariant, the driver needs two SURGICAL, non-destructive git actions:
 *   1. commit EXACTLY the files a kept batch produced, when the agent failed to commit them; and
 *   2. observe whether the tree is clean, so anything left behind can be WARNED about.
 * Nothing here ever discards work: it only stages explicit paths + commits, or reads status.
 *
 * `GitRunner` is injectable so the driver's git use stays unit-testable; the default `runGit`
 * spawns the real `git` (never through a shell).
 */
import { spawn } from 'node:child_process'

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

/** True only when `cwd` is inside a git work tree — a non-repo project then silently skips git. */
export async function isGitRepo(
  cwd: string,
  git: GitRunner = runGit,
): Promise<boolean> {
  const r = await git(['rev-parse', '--is-inside-work-tree'], cwd)
  return r.code === 0 && r.stdout.trim() === 'true'
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
    ...(pathspec.length > 0 ? ['--', ...pathspec] : []),
  ]
  const r = await git(args, cwd)
  if (r.code !== 0) return []
  return r.stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line !== '')
}

/**
 * Stage and commit EXACTLY `files` with `message`, and nothing else. Each path is staged
 * independently (`git add -A -- <file>`) so one odd/unmatched path can't abort the rest, then a
 * pathspec-scoped `git commit -- <files>` records only those paths — never sweeping other staged
 * or dirty files into the commit.
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
  for (const file of files) {
    await git(['add', '-A', '--', file], cwd)
  }
  const commit = await git(['commit', '-m', message, '--', ...files], cwd)
  if (commit.code === 0) return commit
  return git(['commit', '--no-gpg-sign', '-m', message, '--', ...files], cwd)
}
