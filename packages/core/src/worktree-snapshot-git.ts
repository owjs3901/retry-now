import type { GitRunner } from './git.ts'
import { isSafeRepoFilePath } from './git.ts'

export async function gitVisiblePaths(
  root: string,
  git: GitRunner,
  rejectGitlinks: boolean,
): Promise<readonly string[] | null> {
  const result = await git(
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    root,
  )
  if (result.code !== 0) return null
  if (rejectGitlinks) {
    const staged = await git(['ls-files', '-z', '--stage'], root)
    if (
      staged.code !== 0 ||
      staged.stdout.split('\0').some((entry) => entry.startsWith('160000 '))
    ) {
      return null
    }
  }
  const paths = result.stdout.split('\0').filter((path) => path !== '')
  return paths.every(isSafeRepoFilePath) ? [...new Set(paths)].sort() : null
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
