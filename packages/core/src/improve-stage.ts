import { headRevision } from './git.ts'
import type { ItemStageOutcome, ItemStageRun } from './improve-runner.ts'
import type { Paths } from './paths.ts'
import {
  captureRepositorySnapshot,
  repositoryDelta,
  type RepositorySnapshot,
  restoreRepositoryIndex,
  restoreRepositorySnapshot,
  validateRepositoryDelta,
} from './repository-snapshot.ts'
import type { Signal } from './types.ts'

export type StagePhaseExecutor = (
  paths: Paths,
  validate: (signal: Signal) => string | null,
  retryGuard: () => Promise<string | null>,
  run: ItemStageRun,
) => Promise<ItemStageOutcome>

type ImproveStageRepository = {
  readonly capture: typeof captureRepositorySnapshot
  readonly head: typeof headRevision
  readonly restoreIndex: typeof restoreRepositoryIndex
  readonly restoreSnapshot: typeof restoreRepositorySnapshot
}

const DEFAULT_REPOSITORY = {
  capture: captureRepositorySnapshot,
  head: headRevision,
  restoreIndex: restoreRepositoryIndex,
  restoreSnapshot: restoreRepositorySnapshot,
} satisfies ImproveStageRepository

type ImproveStageExecutorInput = {
  readonly paths: Paths
  readonly scope: string
  readonly dryRun: boolean
  readonly initialBaseline: readonly string[]
  readonly initialSnapshot?: RepositorySnapshot
  readonly log: (line: string) => void
  readonly validate: (signal: Signal, run: ItemStageRun) => string | null
  readonly executePhase: StagePhaseExecutor
  readonly repository?: ImproveStageRepository
}

export function createImproveStageExecutor(
  input: ImproveStageExecutorInput,
): (run: ItemStageRun) => Promise<ItemStageOutcome> {
  const repository = input.repository ?? DEFAULT_REPOSITORY
  let approvedSnapshot: RepositorySnapshot | null =
    input.initialSnapshot ?? null
  let stageSnapshot: RepositorySnapshot | null = input.initialSnapshot ?? null

  async function restoreApproved(run: ItemStageRun): Promise<boolean> {
    if (approvedSnapshot === null) return false
    const issue = await repository.restoreSnapshot(
      input.paths.root,
      approvedSnapshot,
    )
    if (issue === null) {
      stageSnapshot = approvedSnapshot
      return true
    }
    input.log(`  ! item ${run.item.id} rollback failed — ${issue}`)
    return false
  }

  return async (run) => {
    const stagePaths: Paths = {
      ...input.paths,
      current: run.artifacts.current,
      signal: run.artifacts.signal,
    }
    if (input.dryRun) {
      return input.executePhase(
        stagePaths,
        (signal) => input.validate(signal, run),
        () => Promise.resolve(null),
        run,
      )
    }

    if (approvedSnapshot === null) {
      approvedSnapshot = await repository.capture(input.paths.root)
      stageSnapshot = approvedSnapshot
    }
    const before = stageSnapshot
    if (approvedSnapshot === null || before === null) {
      input.log(`  ! item ${run.item.id} repository snapshot is unavailable`)
      return { kind: 'failed' }
    }

    const stageHead = before.head
    const outcome = await input.executePhase(
      stagePaths,
      (signal) => input.validate(signal, run),
      async () => {
        const currentHead = await repository.head(input.paths.root)
        if (currentHead !== stageHead) {
          return `Git HEAD changed during item ${run.item.id} ${run.stage}`
        }
        const current = await repository.capture(input.paths.root)
        if (current === null)
          return 'current repository snapshot is unavailable'
        if (current.indexTree !== before.indexTree)
          return 'stage changed Git index'
        const changed = repositoryDelta(before, current)
        return changed.length === 0
          ? null
          : `stage changed files before retry: ${changed.join(', ')}`
      },
      run,
    )

    const actualHead = await repository.head(input.paths.root)
    if (actualHead !== stageHead) {
      input.log(`  ! item ${run.item.id} ${run.stage} changed Git HEAD`)
      return actualHead === null
        ? { kind: 'failed' }
        : {
            kind: 'head-changed',
            expectedHead: stageHead,
            actualHead,
          }
    }
    if (outcome.kind !== 'ok') {
      return (await restoreApproved(run)) ? outcome : { kind: 'failed' }
    }

    const indexIssue = await repository.restoreIndex(input.paths.root, before)
    if (indexIssue !== null) {
      input.log(
        `  ! item ${run.item.id} index restoration failed — ${indexIssue}`,
      )
      await restoreApproved(run)
      return { kind: 'failed' }
    }

    const current = await repository.capture(input.paths.root)
    if (current === null) {
      await restoreApproved(run)
      return { kind: 'failed' }
    }
    if (run.stage === 'implement') {
      const changed = repositoryDelta(approvedSnapshot, current)
      const issue = validateRepositoryDelta(
        changed,
        approvedSnapshot,
        current,
        input.scope,
      )
      if (issue !== null) {
        input.log(
          `  ! item ${run.item.id} implementation escaped scope — ${issue}`,
        )
        await restoreApproved(run)
        return { kind: 'failed' }
      }
      stageSnapshot = current
      return outcome
    }

    const review = outcome.signal.appliedImprovements?.[0]
    if (review?.status !== 'kept') {
      return (await restoreApproved(run)) ? outcome : { kind: 'failed' }
    }
    const issue = validateRepositoryDelta(
      review.files ?? [],
      approvedSnapshot,
      current,
      input.scope,
    )
    if (issue !== null) {
      input.log(`  ! item ${run.item.id} review left an unsafe tree — ${issue}`)
      await restoreApproved(run)
      return { kind: 'failed' }
    }
    approvedSnapshot = current
    stageSnapshot = current
    return outcome
  }
}
