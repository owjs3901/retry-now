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
  | { readonly kind: 'restored' }
  | {
      readonly kind: 'head-changed'
      readonly expectedHead: string
      readonly actualHead: string
    }
  | { readonly kind: 'failed'; readonly issue: string }

function snapshotChanged(
  before: RepositorySnapshot,
  after: RepositorySnapshot,
): boolean {
  return (
    before.head !== after.head ||
    before.indexTree !== after.indexTree ||
    !before.indexFile.equals(after.indexFile) ||
    repositoryDelta(before, after).length > 0
  )
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
  if (after !== null && !snapshotChanged(before, after))
    return { kind: 'clean' }
  const issue = await repository.restore(root, before)
  return issue === null ? { kind: 'restored' } : { kind: 'failed', issue }
}

export async function rollbackIterationRepository(
  root: string,
  before: RepositorySnapshot,
  repository: Pick<
    RepositoryTransaction,
    'restore'
  > = DEFAULT_REPOSITORY_TRANSACTION,
): Promise<string | null> {
  return repository.restore(root, before)
}
