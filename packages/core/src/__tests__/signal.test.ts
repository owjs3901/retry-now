/**
 * `@retry-now/core` signal derivation — `keptCountOf`, the driver's single progress measure.
 *
 * A batch IMPROVE phase can be a partial success, so the driver can no longer read `result`
 * alone to decide whether real progress happened. `keptCountOf` derives the kept count from the
 * per-item `appliedImprovements` list (source of truth), then the summary `keptCount`, then — for
 * a legacy single-change signal that carries neither — maps `result === 'applied'` → 1. That
 * fallback is what keeps `improvementBatchSize = 1` behaving exactly like the original protocol.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'

import { readJson, writeJson } from '../io.ts'
import { resolvePaths } from '../paths.ts'
import {
  beginPhase,
  keptCountOf,
  keptFilesOf,
  normalizeSignal,
  readSignal,
  validateImproveSignal,
} from '../signal.ts'
import type { Current, PlannedImprovement, Signal } from '../types.ts'

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

// --- keptFilesOf: the driver's exact commit scope (only KEPT items' files) ---

test('keptFilesOf: unions the files of every KEPT item, de-duped', () => {
  const sig = improveSignal({
    appliedImprovements: [
      {
        id: '1',
        title: 'a',
        status: 'kept',
        files: ['src/a.ts', 'src/shared.ts'],
      },
      { id: '2', title: 'b', status: 'reverted', files: ['src/b.ts'] }, // excluded
      {
        id: '3',
        title: 'c',
        status: 'kept',
        files: ['src/c.ts', 'src/shared.ts'],
      }, // dedupes shared
      { id: '4', title: 'd', status: 'kept' }, // kept but no files → contributes nothing
    ],
  })
  expect(keptFilesOf(sig).sort()).toEqual([
    'src/a.ts',
    'src/c.ts',
    'src/shared.ts',
  ])
})

test('keptFilesOf: empty when there is no appliedImprovements array', () => {
  expect(keptFilesOf(improveSignal({ keptCount: 2 }))).toEqual([])
})

test('keptFilesOf: excludes files of reverted/failed/skipped items', () => {
  const sig = improveSignal({
    result: 'applied_reverted',
    appliedImprovements: [
      { id: '1', title: 'a', status: 'reverted', files: ['src/a.ts'] },
      { id: '2', title: 'b', status: 'failed', files: ['src/b.ts'] },
      { id: '3', title: 'c', status: 'skipped', files: ['src/c.ts'] },
    ],
  })
  expect(keptFilesOf(sig)).toEqual([])
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

test('normalizeSignal preserves commit-detail fields and the planned count', () => {
  const sig = normalizeSignal({
    iteration: 26,
    phase: 'improve',
    result: 'applied',
    report: 'r',
    plannedCount: 7,
    appliedImprovements: [
      {
        id: '1',
        title: 'faster lookup',
        status: 'kept',
        impact: 'reduces median lookup time',
        decisionReason: 'benchmark improved by 4.2%',
      },
      {
        id: '2',
        title: 'compact parser',
        status: 'reverted',
        impact: 'attempted to reduce allocations',
        decisionReason: 'edge-case test failed; rolled back',
      },
    ],
    summary: 's',
    timestamp: 't',
  })

  expect(sig?.plannedCount).toBe(7)
  expect(sig?.appliedImprovements?.[0]?.impact).toBe(
    'reduces median lookup time',
  )
  expect(sig?.appliedImprovements?.[1]?.decisionReason).toBe(
    'edge-case test failed; rolled back',
  )
})

test('validateImproveSignal accepts one fully-attributed outcome per planned item', () => {
  const plan: readonly PlannedImprovement[] = [
    { id: '1', title: 'keep this' },
    { id: '2', title: 'try that' },
  ]
  const sig = improveSignal({
    plannedCount: 2,
    appliedImprovements: [
      {
        id: '1',
        title: 'keep this',
        status: 'kept',
        impact: 'removes one allocation',
        decisionReason: 'benchmark improved',
        files: ['src/keep.ts'],
      },
      {
        id: '2',
        title: 'try that',
        status: 'reverted',
        impact: 'attempted a smaller representation',
        decisionReason: 'benchmark regressed; rolled back',
      },
    ],
    keptCount: 1,
    revertedCount: 1,
    failedCount: 0,
    skippedCount: 0,
  })

  expect(validateImproveSignal(sig, plan)).toBeNull()
})

test('validateImproveSignal rejects missing outcomes, evidence, files, and unsafe paths', () => {
  const plan: readonly PlannedImprovement[] = [
    { id: '1', title: 'first' },
    { id: '2', title: 'second' },
  ]
  const base = improveSignal({
    plannedCount: 2,
    appliedImprovements: [
      {
        id: '1',
        title: 'first',
        status: 'kept',
        impact: 'faster',
        decisionReason: 'benchmark improved',
        files: ['src/first.ts'],
      },
      {
        id: '2',
        title: 'second',
        status: 'skipped',
        impact: 'would simplify code',
        decisionReason: 'invalidated by item 1',
      },
    ],
    keptCount: 1,
    revertedCount: 0,
    failedCount: 0,
    skippedCount: 1,
  })
  const outcomes = base.appliedImprovements ?? []

  expect(
    validateImproveSignal(
      { ...base, appliedImprovements: outcomes.slice(0, 1) },
      plan,
    ),
  ).toContain('one outcome per planned item')
  expect(
    validateImproveSignal(
      {
        ...base,
        appliedImprovements: outcomes.map((item) =>
          item.id === '1' ? { ...item, impact: '' } : item,
        ),
      },
      plan,
    ),
  ).toContain('impact')
  expect(
    validateImproveSignal(
      {
        ...base,
        appliedImprovements: outcomes.map((item) =>
          item.id === '1' ? { ...item, files: [] } : item,
        ),
      },
      plan,
    ),
  ).toContain('files')
  expect(
    validateImproveSignal(
      {
        ...base,
        appliedImprovements: outcomes.map((item) =>
          item.id === '1' ? { ...item, files: [':(top)**'] } : item,
        ),
      },
      plan,
    ),
  ).toContain('unsafe file path')
})

test('validateImproveSignal rejects mismatched totals, ids, and rolled-up result', () => {
  const plan: readonly PlannedImprovement[] = [{ id: '1', title: 'first' }]
  const valid = improveSignal({
    plannedCount: 1,
    appliedImprovements: [
      {
        id: '1',
        title: 'first',
        status: 'kept',
        impact: 'faster',
        decisionReason: 'benchmark improved',
        files: ['src/first.ts'],
      },
    ],
    keptCount: 1,
    revertedCount: 0,
    failedCount: 0,
    skippedCount: 0,
  })
  const outcomes = valid.appliedImprovements ?? []

  expect(validateImproveSignal({ ...valid, plannedCount: 2 }, plan)).toContain(
    'plannedCount',
  )
  expect(
    validateImproveSignal(
      {
        ...valid,
        appliedImprovements: outcomes.map((item) => ({
          ...item,
          id: '9',
        })),
      },
      plan,
    ),
  ).toContain('plan id/title')
  expect(
    validateImproveSignal({ ...valid, result: 'applied_reverted' }, plan),
  ).toContain('result')
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

// --- beginPhase / readSignal: the on-disk signal channel (driver ↔ agent) ---

test('beginPhase writes a pending signal + a current.json hint carrying the target', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'retry-now-signal-'))
  try {
    const paths = resolvePaths(dir)
    await beginPhase(paths, 12, 'analyze', 'packages/core')
    expect(await readJson<Current>(paths.current)).toEqual({
      iteration: 12,
      padded: '0012',
      phase: 'analyze',
      target: 'packages/core',
    })
    const sig = await readJson<Signal>(paths.signal)
    expect(sig?.result).toBe('pending')
    expect(sig?.iteration).toBe(12)
    expect(sig?.phase).toBe('analyze')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('beginPhase omits the target field for a whole-repo (no-target) life', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'retry-now-signal-'))
  try {
    const paths = resolvePaths(dir)
    await beginPhase(paths, 3, 'improve')
    const current = await readJson<Current>(paths.current)
    expect(current).toEqual({ iteration: 3, padded: '0003', phase: 'improve' })
    expect('target' in (current ?? {})).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readSignal: pending → null, exact match → signal, wrong iteration/phase → null', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'retry-now-signal-'))
  try {
    const paths = resolvePaths(dir)
    // beginPhase leaves a pending signal → readSignal must reject it.
    await beginPhase(paths, 5, 'analyze')
    expect(await readSignal(paths, 5, 'analyze')).toBeNull()

    // a valid, matching analyze signal → returned.
    await writeJson(paths.signal, {
      iteration: 5,
      phase: 'analyze',
      result: 'improvements_found',
      report: 'r',
      summary: 's',
      timestamp: 't',
    })
    expect((await readSignal(paths, 5, 'analyze'))?.result).toBe(
      'improvements_found',
    )
    // right content, wrong iteration or phase → null.
    expect(await readSignal(paths, 6, 'analyze')).toBeNull()
    expect(await readSignal(paths, 5, 'improve')).toBeNull()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
