/**
 * Driver-owned control state.
 *
 * This module is the SINGLE owner of the cross-reincarnation counter
 * (`noImprovementStreak`). The agent never reads or writes it — that is the entire point:
 * past conclusions must not bias a fresh ANALYZE. The driver applies the streak rules and
 * decides when 맺어졌다 (convergence).
 */
import { nowIso, readJson, writeJson } from './io.ts'
import type { Paths } from './paths.ts'
import type { LoopState } from './types.ts'

export async function loadState(
  paths: Paths,
  threshold: number,
  revertThreshold: number,
): Promise<LoopState> {
  const existing = await readJson<Partial<LoopState>>(paths.state)
  if (existing && typeof existing.iteration === 'number') {
    return {
      status: existing.status ?? 'running',
      iteration: existing.iteration,
      noImprovementStreak: existing.noImprovementStreak ?? 0,
      threshold: existing.threshold ?? threshold,
      revertStreak: existing.revertStreak ?? 0,
      revertThreshold: existing.revertThreshold ?? revertThreshold,
      startedAt: existing.startedAt ?? nowIso(),
      updatedAt: existing.updatedAt ?? nowIso(),
    }
  }
  const fresh: LoopState = {
    status: 'running',
    iteration: 0,
    noImprovementStreak: 0,
    threshold,
    revertStreak: 0,
    revertThreshold,
    startedAt: nowIso(),
    updatedAt: nowIso(),
  }
  await writeJson(paths.state, fresh)
  return fresh
}

export async function saveState(paths: Paths, state: LoopState): Promise<void> {
  state.updatedAt = nowIso()
  await writeJson(paths.state, state)
}

/** ANALYZE said no improvements: bump streak. Returns whether we have now converged. */
export function recordNoImprovement(state: LoopState): boolean {
  state.noImprovementStreak += 1
  return state.noImprovementStreak >= state.threshold
}

/** ANALYZE found improvements: the consecutive streak resets to zero. */
export function resetStreak(state: LoopState): void {
  state.noImprovementStreak = 0
}

/**
 * IMPROVE's batch KEPT zero items (every planned item was reverted/failed): bump the revert
 * streak. Returns whether we have now revert-converged — a fresh ANALYZE keeps proposing changes
 * that IMPROVE keeps rolling back, which means there is effectively nothing left worth keeping.
 * (With a batch size of 1 this is exactly the original `applied_reverted`/`failed` case.)
 */
export function recordRevert(state: LoopState): boolean {
  state.revertStreak += 1
  return state.revertStreak >= state.revertThreshold
}

/**
 * IMPROVE's batch KEPT at least one item: real progress, so the consecutive-revert streak resets.
 */
export function resetRevertStreak(state: LoopState): void {
  state.revertStreak = 0
}

/**
 * Fold one completed IMPROVE batch into BOTH cross-life streaks in one place.
 *
 * Reaching this point means ANALYZE found improvements this life, so the no-improvement streak
 * always resets. The revert streak then resets when the batch kept at least one item (real
 * progress), or climbs — possibly to convergence — when it kept nothing. Returns whether the
 * revert streak has now revert-converged. With `improvementBatchSize = 1` this is exactly the old
 * `applied` (kept 1) vs `applied_reverted`/`failed` (kept 0) split.
 */
export function recordImproveOutcome(
  state: LoopState,
  keptCount: number,
): boolean {
  resetStreak(state)
  if (keptCount > 0) {
    resetRevertStreak(state)
    return false
  }
  return recordRevert(state)
}
