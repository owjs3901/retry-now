/**
 * `@retry-now/core` config normalisation — the JSON-boundary parse-don't-validate gate.
 *
 * `normalizeConfig` is the single choke point between untrusted on-disk JSON
 * (`.retry-now/config.json`, hand-edited by users or written by the agent via the
 * `/retry-now` frontend command) and the rest of the engine. The engine assumes a
 * fully-validated `RetryNowConfig`, so every field with a static type must hold at
 * runtime regardless of what the input file actually contained. These tests lock
 * the contract for both shapes:
 *   1. valid input → returned unchanged in every field (no behaviour change)
 *   2. malformed input → falls back to the documented default (no `TypeError`, no
 *      runtime type lie typed as `RetryNowConfig`).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'

import {
  ConfigError,
  DEFAULT_BENCH_RUNS,
  DEFAULT_IMPROVEMENT_BATCH_SIZE,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_QUOTA_WAIT_MS,
  DEFAULT_QUOTA_POLL_MS,
  DEFAULT_REVERT_THRESHOLD,
  DEFAULT_THRESHOLD,
  loadConfig,
  MAX_IMPROVEMENT_BATCH_SIZE,
  MIN_IMPROVEMENT_BATCH_SIZE,
  MIN_QUOTA_POLL_MS,
  normalizeConfig,
} from '../config.ts'
import { writeJson, writeText } from '../io.ts'
import { resolvePaths } from '../paths.ts'
import type { RetryNowConfig } from '../types.ts'

/**
 * Cast helper for the malformed-input tests. The whole point of `normalizeConfig`
 * is to guard a JSON boundary where the static type guarantees nothing, so the test
 * suite must exercise inputs the `Partial<RetryNowConfig>` signature forbids.
 * Confined to this test file; production code never takes this cast.
 */
function bad(value: object): Partial<RetryNowConfig> {
  return value as unknown as Partial<RetryNowConfig>
}

function validRaw(): Partial<RetryNowConfig> {
  return {
    version: 1,
    agent: 'opencode',
    model: 'anthropic/claude-opus-4-7',
    agentProfile: 'build',
    analysis: 'analyse it',
    direction: 'improve it',
    completion: 'done when clean',
    threshold: 7,
    revertThreshold: 4,
    maxIterations: 42,
    skipPermissions: false,
    commitPerIteration: false,
    verifyEnabled: true,
    verifyTest: 'bun test',
    verifyLint: 'bun run lint',
    benchCommand: 'bun run bench',
    benchRuns: 9,
    improvementBatchSize: 5,
    waitForQuota: true,
    quotaPollMs: 300000,
    maxQuotaWaitMs: 7200000,
    targets: ['packages/core', 'packages/cli'],
  }
}

test('valid input round-trips through normalizeConfig unchanged in every field', () => {
  const raw = validRaw()
  const out = normalizeConfig(raw)
  expect(out).toEqual({
    version: 1,
    agent: 'opencode',
    model: 'anthropic/claude-opus-4-7',
    agentProfile: 'build',
    analysis: 'analyse it',
    direction: 'improve it',
    completion: 'done when clean',
    threshold: 7,
    revertThreshold: 4,
    maxIterations: 42,
    skipPermissions: false,
    commitPerIteration: false,
    verifyEnabled: true,
    verifyTest: 'bun test',
    verifyLint: 'bun run lint',
    benchCommand: 'bun run bench',
    benchRuns: 9,
    improvementBatchSize: 5,
    waitForQuota: true,
    quotaPollMs: 300000,
    maxQuotaWaitMs: 7200000,
    targets: ['packages/core', 'packages/cli'],
  })
})

test('non-string analysis falls back to "" and trips the empty-check ConfigError, not a TypeError', () => {
  // Before the fix this threw `TypeError: (raw.analysis ?? "").trim is not a function`.
  // After the fix the non-string is normalised to "" and the existing emptiness check fires.
  expect(() =>
    normalizeConfig(
      bad({ agent: 'opencode', analysis: 42, direction: 'd', completion: 'c' }),
    ),
  ).toThrow(ConfigError)
  expect(() =>
    normalizeConfig(
      bad({ agent: 'opencode', analysis: 42, direction: 'd', completion: 'c' }),
    ),
  ).toThrow('analysis (분석 및 계획) must not be empty')
})

test('non-boolean skipPermissions falls back to the boolean default (true), not the raw string', () => {
  // Before the fix this returned `skipPermissions: 'yes'` typed as `boolean` — runtime type lie.
  const out = normalizeConfig(
    bad({
      agent: 'opencode',
      analysis: 'a',
      direction: 'b',
      completion: 'c',
      skipPermissions: 'yes',
    }),
  )
  expect(typeof out.skipPermissions).toBe('boolean')
  expect(out.skipPermissions).toBe(true)
})

test('non-boolean commitPerIteration falls back to the boolean default (true)', () => {
  const out = normalizeConfig(
    bad({
      agent: 'opencode',
      analysis: 'a',
      direction: 'b',
      completion: 'c',
      commitPerIteration: 0,
    }),
  )
  expect(typeof out.commitPerIteration).toBe('boolean')
  expect(out.commitPerIteration).toBe(true)
})

test('non-boolean verifyEnabled falls back to the boolean default (false)', () => {
  const out = normalizeConfig(
    bad({
      agent: 'opencode',
      analysis: 'a',
      direction: 'b',
      completion: 'c',
      verifyEnabled: 'true',
    }),
  )
  expect(typeof out.verifyEnabled).toBe('boolean')
  expect(out.verifyEnabled).toBe(false)
})

test('non-string model falls back to "" (no .trim crash on an object)', () => {
  const out = normalizeConfig(
    bad({
      agent: 'opencode',
      analysis: 'a',
      direction: 'b',
      completion: 'c',
      model: { provider: 'x' },
    }),
  )
  expect(out.model).toBe('')
})

test('int helper still falls back for non-numeric thresholds (sanity)', () => {
  // Every value here must be one the int helper REJECTS (not coerce to a finite number);
  // e.g. `null` would coerce to 0 via `Number(null)`, so use only non-coercible values.
  const out = normalizeConfig(
    bad({
      agent: 'opencode',
      analysis: 'a',
      direction: 'b',
      completion: 'c',
      threshold: 'not-a-number',
      revertThreshold: 'oops',
      maxIterations: undefined,
      benchRuns: NaN,
    }),
  )
  expect(out.threshold).toBe(DEFAULT_THRESHOLD)
  expect(out.revertThreshold).toBe(DEFAULT_REVERT_THRESHOLD)
  expect(out.maxIterations).toBe(DEFAULT_MAX_ITERATIONS)
  expect(out.benchRuns).toBe(DEFAULT_BENCH_RUNS)
})

test('waitForQuota: a non-boolean falls back to the boolean default (false)', () => {
  const out = normalizeConfig(
    bad({
      agent: 'opencode',
      analysis: 'a',
      direction: 'b',
      completion: 'c',
      waitForQuota: 'yes',
    }),
  )
  expect(typeof out.waitForQuota).toBe('boolean')
  expect(out.waitForQuota).toBe(false)
})

test('quota timings: non-numeric values fall back to their defaults', () => {
  const out = normalizeConfig(
    bad({
      agent: 'opencode',
      analysis: 'a',
      direction: 'b',
      completion: 'c',
      quotaPollMs: 'soon',
      maxQuotaWaitMs: NaN,
    }),
  )
  expect(out.quotaPollMs).toBe(DEFAULT_QUOTA_POLL_MS)
  expect(out.maxQuotaWaitMs).toBe(DEFAULT_MAX_QUOTA_WAIT_MS)
})

test('quotaPollMs: a tiny value is floored to MIN_QUOTA_POLL_MS (no busy-loop)', () => {
  const out = normalizeConfig(
    bad({
      agent: 'opencode',
      analysis: 'a',
      direction: 'b',
      completion: 'c',
      quotaPollMs: 5,
    }),
  )
  expect(out.quotaPollMs).toBe(MIN_QUOTA_POLL_MS)
})

test('maxQuotaWaitMs: a negative value clamps to 0 (no wait)', () => {
  const out = normalizeConfig(
    bad({
      agent: 'opencode',
      analysis: 'a',
      direction: 'b',
      completion: 'c',
      maxQuotaWaitMs: -1000,
    }),
  )
  expect(out.maxQuotaWaitMs).toBe(0)
})

test('quota fields default when omitted (off · 15m poll · 6h cap)', () => {
  const out = normalizeConfig(
    bad({ agent: 'opencode', analysis: 'a', direction: 'b', completion: 'c' }),
  )
  expect(out.waitForQuota).toBe(false)
  expect(out.quotaPollMs).toBe(DEFAULT_QUOTA_POLL_MS)
  expect(out.maxQuotaWaitMs).toBe(DEFAULT_MAX_QUOTA_WAIT_MS)
})

test('improvementBatchSize: non-numeric falls back to the default and stays in range', () => {
  const out = normalizeConfig(
    bad({
      agent: 'opencode',
      analysis: 'a',
      direction: 'b',
      completion: 'c',
      improvementBatchSize: 'lots',
    }),
  )
  expect(out.improvementBatchSize).toBe(DEFAULT_IMPROVEMENT_BATCH_SIZE)
})

test('improvementBatchSize: out-of-range values are clamped to 1..8 (not rejected)', () => {
  const tooBig = normalizeConfig(
    bad({
      agent: 'opencode',
      analysis: 'a',
      direction: 'b',
      completion: 'c',
      improvementBatchSize: 99,
    }),
  )
  expect(tooBig.improvementBatchSize).toBe(MAX_IMPROVEMENT_BATCH_SIZE)

  const tooSmall = normalizeConfig(
    bad({
      agent: 'opencode',
      analysis: 'a',
      direction: 'b',
      completion: 'c',
      improvementBatchSize: 0,
    }),
  )
  expect(tooSmall.improvementBatchSize).toBe(MIN_IMPROVEMENT_BATCH_SIZE)
})

test('improvementBatchSize: a legal value (1 = classic single-change) round-trips unchanged', () => {
  const out = normalizeConfig(
    bad({
      agent: 'opencode',
      analysis: 'a',
      direction: 'b',
      completion: 'c',
      improvementBatchSize: 1,
    }),
  )
  expect(out.improvementBatchSize).toBe(1)
})

test('targets filter still drops non-strings and normalises trailing slashes / backslashes (sanity)', () => {
  const out = normalizeConfig(
    bad({
      agent: 'opencode',
      analysis: 'a',
      direction: 'b',
      completion: 'c',
      targets: [
        'packages/core/',
        'packages\\cli',
        42,
        null,
        '',
        '  packages/x  ',
      ],
    }),
  )
  expect(out.targets).toEqual(['packages/core', 'packages/cli', 'packages/x'])
})

test('an unknown agent is rejected with a ConfigError naming the allowed kinds', () => {
  const raw = bad({
    agent: 'gemini',
    analysis: 'a',
    direction: 'b',
    completion: 'c',
  })
  expect(() => normalizeConfig(raw)).toThrow(ConfigError)
  expect(() => normalizeConfig(raw)).toThrow('agent must be one of')
})

test('loadConfig returns null when no .retry-now/config.json exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'retry-now-config-'))
  try {
    expect(await loadConfig(dir)).toBeNull()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadConfig reads and normalizes an on-disk config.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'retry-now-config-'))
  try {
    await writeJson(resolvePaths(dir).config, validRaw())
    const cfg = await loadConfig(dir)
    expect(cfg?.agent).toBe('opencode')
    expect(cfg?.analysis).toBe('analyse it')
    expect(cfg?.threshold).toBe(7)
    expect(cfg?.improvementBatchSize).toBe(5)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadConfig returns null for a present but malformed config.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'retry-now-config-'))
  try {
    await writeText(resolvePaths(dir).config, '{ not valid json')
    expect(await loadConfig(dir)).toBeNull()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
