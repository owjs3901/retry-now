import { resolve } from 'node:path'

import { type GitRunner, headRevision, runGit } from './git.ts'
import {
  captureSnapshotEntry,
  DEFAULT_SNAPSHOT_FILES,
  type SnapshotEntry,
  type SnapshotFiles,
} from './worktree-snapshot-files.ts'
import {
  gitIndexPath,
  gitVisiblePaths,
  indexTree,
} from './worktree-snapshot-git.ts'

export type RepositorySnapshot = {
  readonly head: string
  readonly indexTree: string
  readonly indexFile: Buffer
  readonly entries: ReadonlyMap<string, SnapshotEntry>
}

export async function captureRepositorySnapshot(
  root: string,
  git: GitRunner = runGit,
  files: SnapshotFiles = DEFAULT_SNAPSHOT_FILES,
): Promise<RepositorySnapshot | null> {
  const head = await headRevision(root, git)
  const index = await indexTree(root, git)
  const indexPath = await gitIndexPath(root, git)
  const paths = await gitVisiblePaths(root, git, true)
  if (head === null || index === null || indexPath === null || paths === null)
    return null
  const indexFile = await files.readFile(indexPath)

  const entries = new Map<string, SnapshotEntry>()
  for (const path of paths) {
    entries.set(path, await captureSnapshotEntry(resolve(root, path), files))
  }

  const finalHead = await headRevision(root, git)
  const finalIndex = await indexTree(root, git)
  const finalIndexFile = await files.readFile(indexPath)
  if (
    finalHead !== head ||
    finalIndex !== index ||
    !finalIndexFile.equals(indexFile)
  ) {
    return null
  }
  return { head, indexTree: index, indexFile, entries }
}
