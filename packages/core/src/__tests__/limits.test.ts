/**
 * `SIGNAL_LIMITS` is the single source of truth for every signal field cap, and its whole purpose is
 * that no other place restates a number. These tests pin the two ways that promise can quietly rot:
 * a cap drifting away from the config constant it must mirror, and a cap that exists in code but
 * never reaches the prompt the agent has to satisfy.
 */
import { expect, test } from 'bun:test'

import { MAX_IMPROVEMENT_BATCH_SIZE } from '../config.ts'
import {
  SIGNAL_FIELD_DISCIPLINE,
  SIGNAL_LIMITS,
  signalLimitsTable,
} from '../limits.ts'

test('the plan ceiling equals the maximum configurable batch size', () => {
  // The driver will not run more items than a batch may contain, so a plan ceiling above
  // MAX_IMPROVEMENT_BATCH_SIZE would admit work the loop then cannot execute, and one below it
  // would reject a plan the user explicitly configured. They must move together.
  expect(SIGNAL_LIMITS.planItems).toBe(MAX_IMPROVEMENT_BATCH_SIZE)
})

test('every cap is a positive integer', () => {
  for (const [field, cap] of Object.entries(SIGNAL_LIMITS)) {
    expect(Number.isInteger(cap)).toBe(true)
    expect(cap).toBeGreaterThan(0)
    expect(field).not.toBe('')
  }
})

test('the rendered table carries one row per cap and no stale numbers', () => {
  const table = signalLimitsTable()
  const rows = table
    .split('\n')
    .filter((line) => line.startsWith('|') && !line.startsWith('|---'))

  // header + one row per cap
  expect(rows).toHaveLength(Object.keys(SIGNAL_LIMITS).length + 1)
  for (const cap of Object.values(SIGNAL_LIMITS)) {
    expect(table).toContain(String(cap))
  }
})

test('the field discipline explains where full evidence belongs', () => {
  // The caps are only satisfiable if the agent is also told where the long-form evidence goes;
  // shipping the numbers without this text is what made the invariant impossible to honour.
  expect(SIGNAL_FIELD_DISCIPLINE).toContain('REPORT')
  expect(SIGNAL_FIELD_DISCIPLINE).toContain('SIGNAL')
  expect(SIGNAL_FIELD_DISCIPLINE).toContain('2-3 sentence')
})
