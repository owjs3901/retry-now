/**
 * `@retry-now/core` driver state — the cross-reincarnation convergence counters.
 *
 * The two counters must climb and reset INDEPENDENTLY: a fresh, unbiased ANALYZE can keep
 * re-proposing the same change that IMPROVE keeps reverting on a benchmark regression, and that
 * pair must still converge (via the revert streak) instead of looping until `maxIterations`.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import { writeJson } from '../io.ts'
import { resolvePaths } from '../paths.ts'
import {
  loadState,
  recordNoImprovement,
  recordRevert,
  resetRevertStreak,
  resetStreak,
  saveState,
} from '../state.ts'
import type { LoopState } from '../types.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'retry-now-state-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function freshState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    status: 'running',
    iteration: 0,
    noImprovementStreak: 0,
    threshold: 5,
    revertStreak: 0,
    revertThreshold: 3,
    startedAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    ...overrides,
  }
}

test('loadState creates a fresh state with both counters zeroed and thresholds set', async () => {
  const s = await loadState(resolvePaths(dir), 5, 3)
  expect(s.iteration).toBe(0)
  expect(s.noImprovementStreak).toBe(0)
  expect(s.threshold).toBe(5)
  expect(s.revertStreak).toBe(0)
  expect(s.revertThreshold).toBe(3)
  expect(s.status).toBe('running')
})

test('loadState round-trips a saved state including the revert counter', async () => {
  const paths = resolvePaths(dir)
  const s = await loadState(paths, 5, 3)
  s.iteration = 7
  s.revertStreak = 2
  await saveState(paths, s)
  const again = await loadState(paths, 5, 3)
  expect(again.iteration).toBe(7)
  expect(again.revertStreak).toBe(2)
})

test('loadState migrates a legacy state file that lacks the revert fields', async () => {
  const paths = resolvePaths(dir)
  await writeJson(paths.state, {
    status: 'running',
    iteration: 4,
    noImprovementStreak: 2,
    threshold: 5,
    startedAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
  })
  const s = await loadState(paths, 5, 3)
  expect(s.iteration).toBe(4)
  expect(s.noImprovementStreak).toBe(2)
  expect(s.revertStreak).toBe(0) // defaulted for old files
  expect(s.revertThreshold).toBe(3) // defaulted from the argument
})

test('recordNoImprovement bumps only the no-improvement streak and converges at threshold', () => {
  const s = freshState({ threshold: 3 })
  expect(recordNoImprovement(s)).toBe(false) // 1
  expect(recordNoImprovement(s)).toBe(false) // 2
  expect(recordNoImprovement(s)).toBe(true) // 3 -> converged
  expect(s.noImprovementStreak).toBe(3)
  expect(s.revertStreak).toBe(0)
})

test('recordRevert bumps only the revert streak and converges at revertThreshold', () => {
  const s = freshState({ revertThreshold: 3 })
  expect(recordRevert(s)).toBe(false) // 1
  expect(recordRevert(s)).toBe(false) // 2
  expect(recordRevert(s)).toBe(true) // 3 -> converged
  expect(s.revertStreak).toBe(3)
  expect(s.noImprovementStreak).toBe(0)
})

test('resetStreak clears only the no-improvement streak', () => {
  const s = freshState({ noImprovementStreak: 4, revertStreak: 2 })
  resetStreak(s)
  expect(s.noImprovementStreak).toBe(0)
  expect(s.revertStreak).toBe(2)
})

test('resetRevertStreak clears only the revert streak', () => {
  const s = freshState({ noImprovementStreak: 4, revertStreak: 2 })
  resetRevertStreak(s)
  expect(s.revertStreak).toBe(0)
  expect(s.noImprovementStreak).toBe(4)
})

test('infinite-revert guard: analyze-finds + improve-reverts every life still converges via reverts', () => {
  // Worst case the feature must guard: each life ANALYZE finds the same improvement (resetStreak)
  // and IMPROVE reverts it on a regression (recordRevert). noImprovementStreak never climbs, so
  // without the revert streak this would run to maxIterations.
  const s = freshState({ threshold: 5, revertThreshold: 3 })
  let converged = false
  let lives = 0
  while (!converged && lives < 50) {
    resetStreak(s) // analyze: improvements_found
    converged = recordRevert(s) // improve: applied_reverted / failed
    lives += 1
  }
  expect(converged).toBe(true)
  expect(lives).toBe(3)
  expect(s.revertStreak).toBe(3)
  expect(s.noImprovementStreak).toBe(0)
})

test('a kept improvement resets the revert streak so progress restarts the count', () => {
  const s = freshState({ revertStreak: 2 })
  resetStreak(s) // analyze found something
  resetRevertStreak(s) // improve applied -> real progress
  expect(s.revertStreak).toBe(0)
  // a later revert then starts climbing again from zero
  expect(recordRevert(s)).toBe(false)
  expect(s.revertStreak).toBe(1)
})
