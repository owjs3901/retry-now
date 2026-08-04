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
  type VisiblePathsFailure,
} from './worktree-snapshot-git.ts'

export type RepositorySnapshot = {
  readonly head: string
  readonly indexTree: string
  readonly indexFile: Buffer
  readonly entries: ReadonlyMap<string, SnapshotEntry>
}

/**
 * Why the transaction boundary could not be captured. The driver refuses to start ANALYZE without a
 * snapshot, so this reason is the ONLY thing it can tell the user about a repository it just
 * declared unusable — it must therefore be the real cause, not a guess.
 */
export type SnapshotFailure =
  | VisiblePathsFailure
  | { readonly reason: 'head-moved' }
  | { readonly reason: 'index-moved' }

export type SnapshotCapture =
  | { readonly kind: 'snapshot'; readonly snapshot: RepositorySnapshot }
  | { readonly kind: 'failed'; readonly failure: SnapshotFailure }

export async function captureRepositorySnapshotResult(
  root: string,
  git: GitRunner = runGit,
  files: SnapshotFiles = DEFAULT_SNAPSHOT_FILES,
): Promise<SnapshotCapture> {
  const head = await headRevision(root, git)
  const index = await indexTree(root, git)
  const indexPath = await gitIndexPath(root, git)
  const visible = await gitVisiblePaths(root, git, true)
  if (head === null || index === null || indexPath === null) {
    return { kind: 'failed', failure: { reason: 'git-failed' } }
  }
  if (visible.kind === 'failed') {
    return { kind: 'failed', failure: visible.failure }
  }
  const entries = new Map<string, SnapshotEntry>()
  for (const path of visible.paths) {
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
  if (finalHead !== head) {
    return { kind: 'failed', failure: { reason: 'head-moved' } }
  }
  if (finalIndex !== index) {
    return { kind: 'failed', failure: { reason: 'index-moved' } }
  }
  return {
    kind: 'snapshot',
    snapshot: { head, indexTree: index, indexFile, entries },
  }
}

/**
 * `captureRepositorySnapshotResult` for the callers that only need to know WHETHER the boundary
 * exists — restoration verification and the per-item guards, which already report their own
 * diagnostic and cannot act on the reason.
 */
export async function captureRepositorySnapshot(
  root: string,
  git: GitRunner = runGit,
  files: SnapshotFiles = DEFAULT_SNAPSHOT_FILES,
): Promise<RepositorySnapshot | null> {
  const capture = await captureRepositorySnapshotResult(root, git, files)
  return capture.kind === 'snapshot' ? capture.snapshot : null
}
