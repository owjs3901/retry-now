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
  const entries = new Map<string, SnapshotEntry>()
  for (const path of paths) {
    entries.set(path, await captureSnapshotEntry(resolve(root, path), files))
  }

  // Rechecking HEAD and the staged tree proves they were stable across entry capture. The raw index
  // is read once, here, so the bytes we keep for restoration are the ones the closing tree check
  // then vouches for; reading it before that check also gives a semantic staging mutation one more
  // chance to be caught. Metadata-only stat-cache churn is deliberately tolerated, and a concurrent
  // command that changes only index flags inside this window stays an accepted race, because
  // capture is not atomic against concurrent worktree edits either.
  const finalHead = await headRevision(root, git)
  const indexFile = await files.readFile(indexPath)
  const finalIndex = await indexTree(root, git)
  if (finalHead !== head || finalIndex !== index) {
    return null
  }
  return { head, indexTree: index, indexFile, entries }
}
