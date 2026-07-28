import { headRevision } from './git.ts'
import type { ItemStageOutcome, ItemStageRun } from './improve-runner.ts'
import { SIGNAL_LIMITS } from './limits.ts'
import type { Paths } from './paths.ts'
import {
  captureRepositorySnapshot,
  repositoryDelta,
  type RepositorySnapshot,
  restoreRepositoryIndex,
  restoreRepositorySnapshot,
  validateRepositoryDelta,
} from './repository-snapshot.ts'
import { oneLine } from './safe-text.ts'
import type { Signal } from './types.ts'

export type StagePhaseExecutor = (
  paths: Paths,
  validate: (signal: Signal) => string | null,
  retryGuard: () => Promise<string | null>,
  run: ItemStageRun,
) => Promise<
  | { readonly kind: 'ok'; readonly signal: Signal }
  | { readonly kind: 'quota' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'failed'; readonly reason: string }
>

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
  readonly verifyKept?: () => Promise<string | null>
  readonly executePhase: StagePhaseExecutor
  readonly repository?: ImproveStageRepository
}

export function createImproveStageExecutor(
  input: ImproveStageExecutorInput,
): (run: ItemStageRun) => Promise<ItemStageOutcome> {
  const repository = input.repository ?? DEFAULT_REPOSITORY
  let approvedSnapshot = input.initialSnapshot ?? null
  let stageSnapshot: RepositorySnapshot | null = input.initialSnapshot ?? null

  function failed(
    reason: string,
    repositoryState: 'approved' | 'unknown',
  ): ItemStageOutcome {
    return repositoryState === 'approved'
      ? { kind: 'failed', repository: 'approved', reason }
      : { kind: 'failed', repository: 'unknown', reason }
  }

  async function restoreApproved(
    run: ItemStageRun,
  ): Promise<'approved' | 'unknown'> {
    if (approvedSnapshot === null) return 'unknown'
    try {
      const issue = await repository.restoreSnapshot(
        input.paths.root,
        approvedSnapshot,
      )
      if (issue !== null) {
        input.log(`  ! item ${run.item.id} rollback failed — ${issue}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      input.log(`  ! item ${run.item.id} rollback threw — ${message}`)
    }

    let current: RepositorySnapshot | null
    try {
      current = await repository.capture(input.paths.root)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      input.log(`  ! item ${run.item.id} rollback proof threw — ${message}`)
      return 'unknown'
    }
    if (
      current === null ||
      current.head !== approvedSnapshot.head ||
      current.indexTree !== approvedSnapshot.indexTree ||
      repositoryDelta(approvedSnapshot, current).length !== 0
    ) {
      return 'unknown'
    }
    stageSnapshot = current
    return 'approved'
  }

  return async (run) => {
    const stagePaths: Paths = {
      ...input.paths,
      current: run.artifacts.current,
      signal: run.artifacts.signal,
    }
    if (input.dryRun) {
      const outcome = await input.executePhase(
        stagePaths,
        (signal) => input.validate(signal, run),
        () => Promise.resolve(null),
        run,
      )
      return outcome.kind === 'failed'
        ? failed(outcome.reason, 'unknown')
        : outcome
    }

    if (approvedSnapshot === null) {
      approvedSnapshot = await repository.capture(input.paths.root)
      stageSnapshot = approvedSnapshot
    }
    const before = stageSnapshot
    if (approvedSnapshot === null || before === null) {
      input.log(`  ! item ${run.item.id} repository snapshot is unavailable`)
      return failed('repository snapshot is unavailable', 'unknown')
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
        ? failed('Git HEAD is unavailable after the item stage', 'unknown')
        : {
            kind: 'head-changed',
            expectedHead: stageHead,
            actualHead,
          }
    }
    if (outcome.kind !== 'ok') {
      const repositoryState = await restoreApproved(run)
      if (outcome.kind === 'failed') {
        return failed(outcome.reason, repositoryState)
      }
      return repositoryState === 'approved'
        ? outcome
        : failed(
            `could not prove the approved repository after ${outcome.kind}`,
            'unknown',
          )
    }

    let indexIssue: string | null
    try {
      indexIssue = await repository.restoreIndex(input.paths.root, before)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      input.log(`  ! item ${run.item.id} index restoration threw — ${message}`)
      return failed(
        `index restoration threw: ${message}`,
        await restoreApproved(run),
      )
    }
    if (indexIssue !== null) {
      input.log(
        `  ! item ${run.item.id} index restoration failed — ${indexIssue}`,
      )
      return failed(
        `index restoration failed: ${indexIssue}`,
        await restoreApproved(run),
      )
    }

    const current = await repository.capture(input.paths.root)
    if (current === null) {
      return failed(
        'repository snapshot is unavailable after index restoration',
        await restoreApproved(run),
      )
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
        return failed(issue, await restoreApproved(run))
      }
      stageSnapshot = current
      return outcome
    }

    const review = outcome.signal.appliedImprovements?.[0]
    if (review?.status !== 'kept') {
      return (await restoreApproved(run)) === 'approved'
        ? outcome
        : failed(
            'could not prove the approved repository after rejected review',
            'unknown',
          )
    }
    const issue = validateRepositoryDelta(
      review.files ?? [],
      approvedSnapshot,
      current,
      input.scope,
    )
    if (issue !== null) {
      input.log(`  ! item ${run.item.id} review left an unsafe tree — ${issue}`)
      return failed(issue, await restoreApproved(run))
    }
    const verificationIssue =
      input.verifyKept === undefined ? null : await input.verifyKept()
    if (verificationIssue !== null) {
      input.log(
        `  ! item ${run.item.id} review kept an item the driver could not verify — ${verificationIssue}`,
      )
      if ((await restoreApproved(run)) === 'unknown') {
        return failed(
          'could not prove the approved repository after failed driver verification',
          'unknown',
        )
      }
      const decisionReason = oneLine(
        `Driver re-ran configured verification after this item and it failed: ${verificationIssue}`,
        SIGNAL_LIMITS.decisionReason,
      )
      return {
        kind: 'ok',
        signal: {
          ...outcome.signal,
          result: 'applied_reverted',
          appliedImprovements: [
            {
              ...review,
              status: 'reverted',
              decisionReason,
              files: [],
            },
          ],
          plannedCount: 1,
          keptCount: 0,
          revertedCount: 1,
          failedCount: 0,
          skippedCount: 0,
        },
      }
    }
    approvedSnapshot = current
    stageSnapshot = current
    return outcome
  }
}
