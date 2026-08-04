import type { GitRunner } from './git.ts'
import { isSafeGitListedPath } from './git.ts'

/**
 * Host-agent runtime state directories written concurrently by platforms such as oh-my-openagent.
 * Untracked entries there are environmental noise, never agent work product.
 */
export const AGENT_STATE_DIRS = ['.omo', '.sisyphus'] as const

export function isAgentStatePath(path: string): boolean {
  const separator = path.indexOf('/')
  const firstSegment = separator === -1 ? path : path.slice(0, separator)
  return AGENT_STATE_DIRS.some((directory) => directory === firstSegment)
}

/**
 * Why the Git-visible path listing could not be established. A bare `null` forced every caller to
 * GUESS the cause — the driver blamed "conflict or submodule" for what was really one unsafe path —
 * so each variant names the actual reason, and the two that have an offending path carry it.
 */
export type VisiblePathsFailure =
  | { readonly reason: 'git-failed' }
  | { readonly reason: 'gitlink'; readonly path: string }
  | { readonly reason: 'unsafe-path'; readonly path: string }

export type VisiblePathsResult =
  | { readonly kind: 'paths'; readonly paths: readonly string[] }
  | { readonly kind: 'failed'; readonly failure: VisiblePathsFailure }

function parsePaths(stdout: string): readonly string[] {
  return stdout.split('\0').filter((path) => path !== '')
}

export async function gitVisiblePaths(
  root: string,
  git: GitRunner,
  rejectGitlinks: boolean,
): Promise<VisiblePathsResult> {
  const trackedResult = await git(['ls-files', '-z', '--cached'], root)
  const untrackedResult = await git(
    ['ls-files', '-z', '--others', '--exclude-standard'],
    root,
  )
  if (trackedResult.code !== 0 || untrackedResult.code !== 0) {
    return { kind: 'failed', failure: { reason: 'git-failed' } }
  }
  if (rejectGitlinks) {
    const staged = await git(['ls-files', '-z', '--stage'], root)
    if (staged.code !== 0) {
      return { kind: 'failed', failure: { reason: 'git-failed' } }
    }
    // `<mode> <object> <stage>\t<path>`; a malformed entry with no tab reports itself, which is
    // strictly better than reporting nothing.
    const gitlink = staged.stdout
      .split('\0')
      .find((entry) => entry.startsWith('160000 '))
    if (gitlink !== undefined) {
      return {
        kind: 'failed',
        failure: {
          reason: 'gitlink',
          path: gitlink.slice(gitlink.indexOf('\t') + 1),
        },
      }
    }
  }
  const tracked = parsePaths(trackedResult.stdout)
  const untracked = parsePaths(untrackedResult.stdout)
  // Fail LOUDLY on the first unsafe path instead of filtering it out: the snapshot is a transaction
  // boundary, so a partial path list would let ANALYZE mutate an unguarded file undetected.
  const unsafe = [...tracked, ...untracked].find(
    (path) => !isSafeGitListedPath(path),
  )
  if (unsafe !== undefined) {
    return { kind: 'failed', failure: { reason: 'unsafe-path', path: unsafe } }
  }
  return {
    kind: 'paths',
    paths: [
      ...new Set([
        ...tracked,
        ...untracked.filter((path) => !isAgentStatePath(path)),
      ]),
    ].sort(),
  }
}

export async function gitIndexPath(
  root: string,
  git: GitRunner,
): Promise<string | null> {
  const result = await git(
    ['rev-parse', '--path-format=absolute', '--git-path', 'index'],
    root,
  )
  return result.code === 0 && result.stdout.trim() !== ''
    ? result.stdout.trim()
    : null
}

export async function indexTree(
  root: string,
  git: GitRunner,
): Promise<string | null> {
  const result = await git(['write-tree'], root)
  return result.code === 0 ? result.stdout.trim() : null
}
