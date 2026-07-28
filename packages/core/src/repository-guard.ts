import { headRevision } from './git.ts'
import {
  captureRepositorySnapshot,
  repositoryDelta,
  type RepositorySnapshot,
  restoreRepositorySnapshot,
} from './repository-snapshot.ts'

type RepositoryTransaction = {
  readonly capture: typeof captureRepositorySnapshot
  readonly head: typeof headRevision
  readonly restore: typeof restoreRepositorySnapshot
}

const DEFAULT_REPOSITORY_TRANSACTION = {
  capture: captureRepositorySnapshot,
  head: headRevision,
  restore: restoreRepositorySnapshot,
} satisfies RepositoryTransaction

export type AnalyzeRepositoryOutcome =
  | { readonly kind: 'clean' }
  | { readonly kind: 'restored'; readonly changed: readonly string[] }
  | {
      readonly kind: 'head-changed'
      readonly expectedHead: string
      readonly actualHead: string
    }
  | { readonly kind: 'failed'; readonly issue: string }

function snapshotChanges(
  before: RepositorySnapshot,
  after: RepositorySnapshot,
): string[] {
  const changed = repositoryDelta(before, after)
  // Flag the index only when its STAGED TREE changed — not when only the raw `.git/index` bytes
  // differ. Git rewrites the index's stat-cache (mtime/inode/size) opportunistically whenever any
  // command touches the repo (editor/LSP indexing, `git status`, a background `cargo`…), which
  // leaves the staged tree byte-for-byte identical. In native (in-process) mode the ANALYZE child
  // runs INSIDE the live opencode instance (LSP on), so that benign stat-cache churn is unavoidable
  // and must NOT be mistaken for an ANALYZE mutation. The IMPROVE stage already compares `indexTree`
  // alone (improve-stage.ts:114); this aligns ANALYZE with it. `indexTree` still catches every real
  // staged change, and `indexFile` is still used for exact restoration + capture-consistency.
  if (before.indexTree !== after.indexTree) {
    changed.unshift('Git index')
  }
  return changed
}

export async function guardAnalyzeRepository(
  root: string,
  before: RepositorySnapshot,
  repository: RepositoryTransaction = DEFAULT_REPOSITORY_TRANSACTION,
): Promise<AnalyzeRepositoryOutcome> {
  const actualHead = await repository.head(root)
  if (actualHead === null) {
    return { kind: 'failed', issue: 'Git HEAD is unavailable after ANALYZE' }
  }
  if (actualHead !== before.head) {
    return { kind: 'head-changed', expectedHead: before.head, actualHead }
  }
  const after = await repository.capture(root)
  const changed = after === null ? [] : snapshotChanges(before, after)
  if (after !== null && changed.length === 0) return { kind: 'clean' }
  try {
    const issue = await repository.restore(root, before)
    return issue === null
      ? { kind: 'restored', changed }
      : { kind: 'failed', issue }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      kind: 'failed',
      issue: `repository restoration threw: ${message}`,
    }
  }
}

export async function rollbackIterationRepository(
  root: string,
  before: RepositorySnapshot,
  repository: Pick<
    RepositoryTransaction,
    'restore'
  > = DEFAULT_REPOSITORY_TRANSACTION,
): Promise<string | null> {
  try {
    return await repository.restore(root, before)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `repository restoration threw: ${message}`
  }
}
