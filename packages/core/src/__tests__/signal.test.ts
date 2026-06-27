/**
 * `@retry-now/core` signal derivation — `keptCountOf`, the driver's single progress measure.
 *
 * A batch IMPROVE phase can be a partial success, so the driver can no longer read `result`
 * alone to decide whether real progress happened. `keptCountOf` derives the kept count from the
 * per-item `appliedImprovements` list (source of truth), then the summary `keptCount`, then — for
 * a legacy single-change signal that carries neither — maps `result === 'applied'` → 1. That
 * fallback is what keeps `improvementBatchSize = 1` behaving exactly like the original protocol.
 */
import { expect, test } from 'bun:test'

import { keptCountOf, normalizeSignal } from '../signal.ts'
import type { Signal } from '../types.ts'

function improveSignal(overrides: Partial<Signal>): Signal {
  return {
    iteration: 1,
    phase: 'improve',
    result: 'applied',
    report: '(test)',
    summary: '(test)',
    timestamp: '2020-01-01T00:00:00.000Z',
    ...overrides,
  }
}

test('counts the kept items in appliedImprovements (the source of truth)', () => {
  const sig = improveSignal({
    appliedImprovements: [
      { id: '1', title: 'a', status: 'kept' },
      { id: '2', title: 'b', status: 'reverted' },
      { id: '3', title: 'c', status: 'kept' },
      { id: '4', title: 'd', status: 'skipped' },
    ],
    keptCount: 99, // deliberately wrong — the array must win
  })
  expect(keptCountOf(sig)).toBe(2)
})

test('an empty appliedImprovements array means zero kept (a fully-reverted batch)', () => {
  const sig = improveSignal({
    result: 'applied_reverted',
    appliedImprovements: [
      { id: '1', title: 'a', status: 'reverted' },
      { id: '2', title: 'b', status: 'failed' },
    ],
  })
  expect(keptCountOf(sig)).toBe(0)
})

test('falls back to keptCount when no per-item array is present', () => {
  const sig = improveSignal({ keptCount: 3 })
  expect(keptCountOf(sig)).toBe(3)
})

test('a non-finite keptCount is ignored and the legacy result fallback applies', () => {
  const sig = improveSignal({ keptCount: Number.NaN })
  expect(keptCountOf(sig)).toBe(1) // result === 'applied'
})

test('legacy single-change signal: result "applied" maps to 1 kept', () => {
  const sig = improveSignal({}) // no batch fields, result defaults to 'applied'
  expect(keptCountOf(sig)).toBe(1)
})

test('legacy single-change signal: a reverted/failed result maps to 0 kept', () => {
  expect(keptCountOf(improveSignal({ result: 'applied_reverted' }))).toBe(0)
  expect(keptCountOf(improveSignal({ result: 'failed' }))).toBe(0)
})

// --- normalizeSignal: the parse-don't-validate gate at the agent→driver boundary ---

test('normalizeSignal rejects a non-object, a missing/NaN iteration, a bad phase or result', () => {
  expect(normalizeSignal(null)).toBeNull()
  expect(normalizeSignal('nope')).toBeNull()
  expect(
    normalizeSignal({ phase: 'analyze', result: 'no_improvements' }),
  ).toBeNull() // no iteration
  expect(
    normalizeSignal({
      iteration: Number.NaN,
      phase: 'analyze',
      result: 'no_improvements',
    }),
  ).toBeNull()
  expect(
    normalizeSignal({ iteration: 1, phase: 'sideways', result: 'applied' }),
  ).toBeNull()
  expect(
    normalizeSignal({ iteration: 1, phase: 'improve', result: 'made_up' }),
  ).toBeNull()
})

test('normalizeSignal accepts a pending signal (the driver, not the gate, rejects pending)', () => {
  const sig = normalizeSignal({
    iteration: 4,
    phase: 'analyze',
    result: 'pending',
    report: '',
    summary: '',
    timestamp: '',
  })
  expect(sig?.result).toBe('pending')
})

test('normalizeSignal cleans a valid analyze signal and keeps a well-formed plan', () => {
  const sig = normalizeSignal({
    iteration: 12,
    phase: 'analyze',
    result: 'improvements_found',
    report: 'r',
    nextImprovement: 'first',
    plannedImprovements: [
      { id: '1', title: 'a', risk: 'low' },
      { id: '2', title: 'b', risk: 'bogus' }, // bad risk dropped, item kept
    ],
    summary: 's',
    timestamp: 't',
  })
  expect(sig?.plannedImprovements).toEqual([
    { id: '1', title: 'a', risk: 'low' },
    { id: '2', title: 'b' },
  ])
})

test('normalizeSignal drops malformed applied items and non-string file entries', () => {
  const sig = normalizeSignal({
    iteration: 12,
    phase: 'improve',
    result: 'applied',
    report: 'r',
    appliedImprovements: [
      { id: '1', title: 'a', status: 'kept', files: ['x.ts', 7, 'y.ts'] },
      { id: '2', title: 'b', status: 'not-a-status' }, // dropped: bad status
      { title: 'c', status: 'kept' }, // dropped: missing id
    ],
    summary: 's',
    timestamp: 't',
  })
  expect(sig?.appliedImprovements).toEqual([
    { id: '1', title: 'a', status: 'kept', files: ['x.ts', 'y.ts'] },
  ])
})

test('normalizeSignal drops non-numeric / negative counts but keeps valid ones', () => {
  const sig = normalizeSignal({
    iteration: 12,
    phase: 'improve',
    result: 'applied',
    report: 'r',
    keptCount: 2,
    revertedCount: '1', // string -> dropped
    failedCount: -3, // negative -> dropped
    skippedCount: 0,
    summary: 's',
    timestamp: 't',
  })
  expect(sig?.keptCount).toBe(2)
  expect(sig?.skippedCount).toBe(0)
  expect('revertedCount' in (sig ?? {})).toBe(false)
  expect('failedCount' in (sig ?? {})).toBe(false)
})

test('normalizeSignal coerces missing report/summary/timestamp to empty strings', () => {
  const sig = normalizeSignal({
    iteration: 1,
    phase: 'analyze',
    result: 'no_improvements',
  })
  expect(sig).not.toBeNull()
  expect(sig?.report).toBe('')
  expect(sig?.summary).toBe('')
  expect(sig?.timestamp).toBe('')
})
