import { validateCommitFileAttribution } from './git.ts'
import type { RepositorySnapshot } from './worktree-snapshot-capture.ts'
import type { SnapshotEntry } from './worktree-snapshot-files.ts'

export function snapshotEntriesEqual(
  left: SnapshotEntry | undefined,
  right: SnapshotEntry | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  if (left.kind !== right.kind) return false
  switch (left.kind) {
    case 'missing':
    case 'directory':
      return true
    case 'symlink':
      return right.kind === 'symlink' && left.target === right.target
    case 'file':
      return (
        right.kind === 'file' &&
        left.mode === right.mode &&
        left.content.equals(right.content)
      )
  }
}

export function repositoryDelta(
  before: RepositorySnapshot,
  after: RepositorySnapshot,
): string[] {
  const paths = new Set([...before.entries.keys(), ...after.entries.keys()])
  return [...paths]
    .filter(
      (path) =>
        !snapshotEntriesEqual(
          before.entries.get(path),
          after.entries.get(path),
        ),
    )
    .sort()
}

export function validateRepositoryDelta(
  files: readonly string[],
  before: RepositorySnapshot,
  after: RepositorySnapshot,
  scope: string,
): string | null {
  return validateCommitFileAttribution(
    files,
    [],
    repositoryDelta(before, after),
    scope,
  )
}
