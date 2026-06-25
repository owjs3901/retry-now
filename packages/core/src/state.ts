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
 * IMPROVE did not keep a change (`applied_reverted`/`failed`): bump the revert streak. Returns
 * whether we have now revert-converged — the same kind of change kept getting proposed and
 * reverted, which means there is effectively nothing left worth keeping.
 */
export function recordRevert(state: LoopState): boolean {
  state.revertStreak += 1
  return state.revertStreak >= state.revertThreshold
}

/** IMPROVE KEPT a change (`applied`): real progress, so the consecutive-revert streak resets. */
export function resetRevertStreak(state: LoopState): void {
  state.revertStreak = 0
}
