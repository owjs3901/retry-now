import type { GitRunner } from './git.ts'
import { isSafeRepoFilePath } from './git.ts'

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

function parsePaths(stdout: string): readonly string[] | null {
  const paths = stdout.split('\0').filter((path) => path !== '')
  return paths.every(isSafeRepoFilePath) ? paths : null
}

export async function gitVisiblePaths(
  root: string,
  git: GitRunner,
  rejectGitlinks: boolean,
): Promise<readonly string[] | null> {
  const trackedResult = await git(['ls-files', '-z', '--cached'], root)
  const untrackedResult = await git(
    ['ls-files', '-z', '--others', '--exclude-standard'],
    root,
  )
  if (trackedResult.code !== 0 || untrackedResult.code !== 0) return null
  if (rejectGitlinks) {
    const staged = await git(['ls-files', '-z', '--stage'], root)
    if (
      staged.code !== 0 ||
      staged.stdout.split('\0').some((entry) => entry.startsWith('160000 '))
    ) {
      return null
    }
  }
  const tracked = parsePaths(trackedResult.stdout)
  const untracked = parsePaths(untrackedResult.stdout)
  if (tracked === null || untracked === null) return null
  return [
    ...new Set([
      ...tracked,
      ...untracked.filter((path) => !isAgentStatePath(path)),
    ]),
  ].sort()
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
