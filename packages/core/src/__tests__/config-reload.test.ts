/**
 * Life-boundary config reload.
 *
 * The bug this locks down: a 22-hour run whose `maxIterations` was edited from 50 to 100 mid-flight
 * ignored the edit completely and silently, forcing a full stop/restart that threw away the life in
 * progress. So the contract under test is two-sided — the loop-control counters MUST re-apply, and
 * every other changed field MUST be reported as deliberately pinned rather than quietly dropped.
 */
import { expect, test } from 'bun:test'

import { normalizeConfig } from '../config.ts'
import {
  diffLoopConfig,
  loadConfigBaseline,
  RELOADABLE_FIELDS,
  reloadLogLines,
  reloadLoopConfig,
} from '../config-reload.ts'
import type { RetryNowConfig } from '../types.ts'

function config(overrides: Partial<RetryNowConfig> = {}): RetryNowConfig {
  return {
    ...normalizeConfig({
      analysis: 'analyze everything',
      direction: 'smallest correct change',
      completion: 'nothing left worth doing',
    }),
    ...overrides,
  }
}

test('allowlist is exactly the loop-control counters', () => {
  expect([...RELOADABLE_FIELDS].sort()).toEqual([
    'maxIterations',
    'revertThreshold',
    'threshold',
  ])
})

test('every allowlisted field is actually re-applied by the merge', () => {
  // Guards the hand-written merge in `applyReloadable` against drifting from RELOADABLE_FIELDS:
  // a field on the list that the merge forgot would be silently ignored, which is the exact class
  // of bug this module exists to remove.
  const active = config({ maxIterations: 50, threshold: 5, revertThreshold: 3 })
  const next = config({ maxIterations: 100, threshold: 9, revertThreshold: 7 })
  const { config: merged, applied } = diffLoopConfig(active, active, next)
  for (const field of RELOADABLE_FIELDS) {
    expect(merged[field]).toBe(next[field])
    expect(applied.some((change) => change.field === field)).toBe(true)
  }
})

test('maxIterations 50 -> 100 is applied and logged with both values', () => {
  const active = config({ maxIterations: 50 })
  const next = config({ maxIterations: 100 })
  const reload = { ...diffLoopConfig(active, active, next), issue: null }
  expect(reload.config.maxIterations).toBe(100)
  expect(reload.applied).toEqual([
    { field: 'maxIterations', from: '50', to: '100' },
  ])
  expect(reload.pinned).toEqual([])
  expect(reloadLogLines(reload)).toEqual([
    '  config reloaded: maxIterations 50 -> 100',
  ])
})

test('an unchanged config produces no changes and no log noise', () => {
  const reload = {
    ...diffLoopConfig(config(), config(), config()),
    issue: null,
  }
  expect(reload.applied).toEqual([])
  expect(reload.pinned).toEqual([])
  expect(reloadLogLines(reload)).toEqual([])
})

test('dangerous fields stay pinned, keep the running value, and say why', () => {
  const active = config({ improvementBatchSize: 8, targets: [] })
  const next = config({ improvementBatchSize: 2, targets: ['crates/core'] })
  const reload = { ...diffLoopConfig(active, active, next), issue: null }
  expect(reload.config.improvementBatchSize).toBe(8)
  expect(reload.config.targets).toEqual([])
  const fields = reload.pinned.map((change) => change.field)
  expect(fields).toContain('improvementBatchSize')
  expect(fields).toContain('targets')
  for (const change of reload.pinned) {
    expect(change.reason.length).toBeGreaterThan(0)
  }
  const lines = reloadLogLines(reload).join('\n')
  expect(lines).toContain('config pinned for this run: improvementBatchSize')
  expect(lines).toContain('per-item backup directories')
  expect(lines).toContain('Restart to apply it.')
})

test('agent and model changes are pinned with the generic reason', () => {
  const reload = {
    ...diffLoopConfig(config(), config(), config({ improveAgent: 'claude' })),
    issue: null,
  }
  expect(reload.config.improveAgent).not.toBe('claude')
  expect(reload.pinned).toHaveLength(1)
  expect(reload.pinned[0]?.field).toBe('improveAgent')
  expect(reload.pinned[0]?.reason).toContain('reload allowlist')
})

test('a deleted or unparseable config keeps the running values and reports the issue', async () => {
  const active = config({ maxIterations: 50 })
  const reload = await reloadLoopConfig('/nowhere', active, active, () =>
    Promise.resolve(null),
  )
  expect(reload.config).toBe(active)
  expect(reload.applied).toEqual([])
  expect(reload.issue).toContain('keeping the values this run started with')
  expect(reloadLogLines(reload)[0]).toContain('! config reload:')
})

test('a throwing loader cannot take down a long-running loop', async () => {
  const active = config()
  const reload = await reloadLoopConfig('/nowhere', active, active, () =>
    Promise.reject(new Error('threshold (수렴 임계값) must be >= 1')),
  )
  expect(reload.config).toBe(active)
  expect(reload.issue).toContain('must be >= 1')
})

test('reloadLoopConfig folds a real on-disk change through the allowlist', async () => {
  const active = config({ maxIterations: 50, benchRuns: 5 })
  const reload = await reloadLoopConfig('/project', active, active, () =>
    Promise.resolve(config({ maxIterations: 100, benchRuns: 9 })),
  )
  expect(reload.issue).toBeNull()
  expect(reload.config.maxIterations).toBe(100)
  expect(reload.config.benchRuns).toBe(5) // pinned: the bench baseline was measured with 5
  expect(reload.pinned.map((change) => change.field)).toEqual(['benchRuns'])
})

test('a CLI override is NEVER reported as an on-disk change', async () => {
  // Found by running `retry-now run --dry-run --no-commit`: the override sets commitPerIteration
  // false on the RUNNING config while the file still says true, so diffing the running config
  // against the file reported the user's own flag as pinned drift once per life, forever.
  const onDisk = config({ commitPerIteration: true })
  const active = config({ commitPerIteration: false }) // --no-commit layered on top
  const reload = await reloadLoopConfig('/project', active, onDisk, () =>
    Promise.resolve(onDisk),
  )
  expect(reload.applied).toEqual([])
  expect(reload.pinned).toEqual([])
  expect(reloadLogLines(reload)).toEqual([])
  expect(reload.config.commitPerIteration).toBe(false) // override survives the reload
})

test('an on-disk edit is reported ONCE, not once per life', async () => {
  const first = config({ maxIterations: 50 })
  const second = config({ maxIterations: 100 })
  const active = config({ maxIterations: 50, commitPerIteration: false })

  const one = await reloadLoopConfig('/p', active, first, () =>
    Promise.resolve(second),
  )
  expect(one.applied).toHaveLength(1)
  expect(one.config.maxIterations).toBe(100)
  expect(one.config.commitPerIteration).toBe(false) // override preserved through the merge

  // The next boundary carries `onDisk` forward, so the same edit is not re-announced.
  const two = await reloadLoopConfig('/p', one.config, one.onDisk, () =>
    Promise.resolve(second),
  )
  expect(two.applied).toEqual([])
  expect(reloadLogLines(two)).toEqual([])
})

test('a failed re-read carries the previous on-disk baseline forward', async () => {
  const onDisk = config({ maxIterations: 50 })
  const reload = await reloadLoopConfig('/p', onDisk, onDisk, () =>
    Promise.resolve(null),
  )
  expect(reload.onDisk).toBe(onDisk)
  expect(reload.issue).not.toBeNull()
})

test('loadConfigBaseline never throws on a config that violates a constraint', async () => {
  // `loadConfig` returns null for an unparseable file but THROWS ConfigError for one that parses and
  // is invalid. Found by running the suite: an unguarded baseline read crashed the whole driver.
  const fallback = config()
  expect(
    await loadConfigBaseline('/p', fallback, () =>
      Promise.reject(new Error('maxIterations must be >= 1')),
    ),
  ).toBe(fallback)
  expect(
    await loadConfigBaseline('/p', fallback, () => Promise.resolve(null)),
  ).toBe(fallback)
  const onDisk = config({ maxIterations: 77 })
  expect(
    await loadConfigBaseline('/p', fallback, () => Promise.resolve(onDisk)),
  ).toBe(onDisk)
})
