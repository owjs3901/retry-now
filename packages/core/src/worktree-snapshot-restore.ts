import { resolve } from 'node:path'

import { type GitRunner, headRevision, runGit } from './git.ts'
import {
  captureRepositorySnapshot,
  type RepositorySnapshot,
} from './worktree-snapshot-capture.ts'
import {
  repositoryDelta,
  snapshotEntriesEqual,
} from './worktree-snapshot-compare.ts'
import {
  captureSnapshotEntry,
  DEFAULT_SNAPSHOT_FILES,
  restoreSnapshotEntry,
  type SnapshotEntry,
  type SnapshotFiles,
} from './worktree-snapshot-files.ts'
import {
  gitIndexPath,
  gitVisiblePaths,
  indexTree,
  isAgentStatePath,
} from './worktree-snapshot-git.ts'

export async function restoreRepositoryIndex(
  root: string,
  snapshot: RepositorySnapshot,
  git: GitRunner = runGit,
  files: SnapshotFiles = DEFAULT_SNAPSHOT_FILES,
): Promise<string | null> {
  if ((await headRevision(root, git)) !== snapshot.head) {
    return 'Git HEAD changed; refusing index restoration'
  }
  const indexPath = await gitIndexPath(root, git)
  if (indexPath === null) return 'could not resolve the Git index path'
  const temporaryPath = `${indexPath}.retry-now-${process.pid}.tmp`
  try {
    await files.writeFile(temporaryPath, snapshot.indexFile)
    await files.rename(temporaryPath, indexPath)
  } catch (error) {
    if (!(error instanceof Error)) throw error
    try {
      await files.rm(temporaryPath, { recursive: false, force: true })
    } catch (cleanupError) {
      if (!(cleanupError instanceof Error)) throw cleanupError
      return `could not restore the approved Git index: ${error.message}; temporary index cleanup also failed: ${cleanupError.message}`
    }
    return `could not restore the approved Git index: ${error.message}`
  }
  return (await indexTree(root, git)) === snapshot.indexTree
    ? null
    : 'restored Git index does not match the approved tree'
}

export async function restoreRepositorySnapshot(
  root: string,
  snapshot: RepositorySnapshot,
  git: GitRunner = runGit,
  files: SnapshotFiles = DEFAULT_SNAPSHOT_FILES,
): Promise<string | null> {
  const currentHead = await headRevision(root, git)
  if (currentHead !== snapshot.head) {
    return `Git HEAD changed from ${snapshot.head} to ${currentHead ?? '(unavailable)'}`
  }
  const currentPaths = await gitVisiblePaths(root, git, false)
  if (currentPaths === null) return 'current repository paths are unavailable'
  const currentEntries = new Map<string, SnapshotEntry>()
  for (const path of currentPaths) {
    currentEntries.set(
      path,
      await captureSnapshotEntry(resolve(root, path), files),
    )
  }

  // restoreRepositoryIndex already converts ordinary fs failures into a returned message; this
  // guards the residual case where it re-throws (a genuinely unexpected non-Error rejection),
  // so this function keeps its `Promise<string | null>` contract instead of ever throwing.
  let indexIssue: string | null
  try {
    indexIssue = await restoreRepositoryIndex(root, snapshot, git, files)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `could not restore the approved Git index: ${message}`
  }
  if (indexIssue !== null) return indexIssue

  const paths = new Set([...snapshot.entries.keys(), ...currentEntries.keys()])
  try {
    for (const path of paths) {
      const snapshotEntry = snapshot.entries.get(path)
      if (snapshotEntry === undefined && isAgentStatePath(path)) continue
      if (!snapshotEntriesEqual(snapshotEntry, currentEntries.get(path))) {
        await restoreSnapshotEntry(root, path, snapshotEntry, files)
      }
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return `could not restore approved file content: ${error.message}`
  }

  const verified = await captureRepositorySnapshot(root, git, files)
  if (verified === null) return 'restored repository snapshot is unavailable'
  // The raw index remains the restoration mechanism, but restoring file contents can churn Git's
  // stat cache afterward. `indexTree` already proves that the staged paths, modes, and blobs match,
  // so raw index serialization is deliberately not an equality post-condition.
  if (
    verified.head !== snapshot.head ||
    verified.indexTree !== snapshot.indexTree ||
    repositoryDelta(snapshot, verified).length > 0
  ) {
    const prefix =
      'repository did not match the approved snapshot after restoration:'
    if (verified.head !== snapshot.head) {
      return `${prefix} HEAD is ${verified.head}, expected ${snapshot.head}`
    }
    if (verified.indexTree !== snapshot.indexTree) {
      return `${prefix} staged tree is ${verified.indexTree}, expected ${snapshot.indexTree}`
    }
    const differingFiles = repositoryDelta(snapshot, verified)
    const visibleFiles = differingFiles.slice(0, 5)
    const remaining = differingFiles.length - visibleFiles.length
    const suffix = remaining > 0 ? ` (+${remaining} more)` : ''
    return `${prefix} ${differingFiles.length} file(s) differ (${visibleFiles.join(', ')})${suffix}`
  }
  return null
}
