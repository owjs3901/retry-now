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
    let issue: string | null
    try {
      issue = await repository.restoreSnapshot(
        input.paths.root,
        approvedSnapshot,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      input.log(`  ! item ${run.item.id} rollback threw — ${message}`)
      return false
    }
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

        const indexChanged = current.indexTree !== before.indexTree
        const changed = repositoryDelta(before, current)
        if (!indexChanged && changed.length === 0) return null

        // A failed attempt's own writes are recoverable: this driver holds the exact
        // pre-stage snapshot and a proven restore primitive, so undo them and let the next
        // fresh session start clean instead of sacrificing the whole item (and its
        // PHASE_ATTEMPTS retry budget) over dirt that is safe to discard.
        let restoreIssue: string | null
        try {
          restoreIssue = await repository.restoreSnapshot(
            input.paths.root,
            before,
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return `repository restoration threw before retry: ${message}`
        }
        if (restoreIssue !== null) {
          return `could not restore repository before retry: ${restoreIssue}`
        }
        const dirt = [...(indexChanged ? ['Git index'] : []), ...changed].join(
          ', ',
        )
        input.log(
          `  ! item ${run.item.id} ${run.stage} restored attempt changes before retry: ${dirt}`,
        )
        return null
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

    let indexIssue: string | null
    try {
      indexIssue = await repository.restoreIndex(input.paths.root, before)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      input.log(`  ! item ${run.item.id} index restoration threw — ${message}`)
      await restoreApproved(run)
      return { kind: 'failed' }
    }
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
