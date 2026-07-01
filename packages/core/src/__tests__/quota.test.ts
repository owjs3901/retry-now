/**
 * `@retry-now/core` quota-exhaustion detection.
 *
 * A self-improvement loop frequently runs ON code that is *about* rate limiting (the
 * opencode-auth-load-balancer it was built for is exactly that), so detection MUST fire on a
 * real provider 429 / quota runtime error but NEVER on a test name like "rotates on 429", a
 * `grep "429"`, a `status: 429` mock, or a source comment that merely mentions "rate-limited /
 * over quota". These tests lock both polarities so the driver never mistakes a normal analysis
 * of rate-limiting code for an out-of-quota wall.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import { looksQuotaExhausted, quotaExhaustedInLog } from '../quota.ts'

// REAL runtime errors that mean "out of quota" — detection MUST fire on every one.
const QUOTA_POSITIVES: readonly string[] = [
  'Error: anthropic account "contact" returned 429',
  'Error: openai account "work-2" returned 402',
  'anthropic: no usable account in the load-balancer pool',
  'AI_APICallError: Rate limited',
  'AI_RetryError: exhausted retries: rate limit (429)',
  'rate limit exceeded',
  'Too Many Requests',
  'usage limit reached for this account',
  'quota exceeded',
  'insufficient_quota',
]

// Lines that MENTION rate limits / 429 but are NOT a runtime quota failure — MUST NOT fire.
const QUOTA_NEGATIVES: readonly string[] = [
  '(pass) load-balanced fetch > picks lowest-weekly, rotates on 429, transforms body',
  '(pass) honors retry-after when cooling down a rate-limited account',
  '→ Read src/fetch.ts',
  '$ grep -n "429" src/fetch.ts',
  '  status: 429,',
  ' *   "account" → this account is rate-limited/over quota (429/402). Cool it down, try next.',
  'const ACCOUNT_COOLDOWN_MS = 60_000 // cool a rate-limited account',
  '`${adapter.id} account "${account.label}" returned ${res.status}`',
  'all 225 tests passed',
  '',
]

test('fires on every real quota / rate-limit runtime error shape', () => {
  for (const line of QUOTA_POSITIVES) {
    expect(looksQuotaExhausted(line)).toBe(true)
  }
})

test('does NOT fire on test names, greps, mocks, or comments mentioning 429 / rate limits', () => {
  for (const line of QUOTA_NEGATIVES) {
    expect(looksQuotaExhausted(line)).toBe(false)
  }
})

test('a context-length APICallError is not misread as quota (waiting would never clear it)', () => {
  expect(
    looksQuotaExhausted('AI_APICallError: prompt is too long: 1143194 tokens'),
  ).toBe(false)
})

test('detects a marker embedded in a larger multi-line log', () => {
  const log = [
    '→ Read src/fetch.ts',
    '$ bun test',
    '  (pass) rotates on 429',
    'Error: anthropic account "burner" returned 429',
    '> Sisyphus - ultraworker',
  ].join('\n')
  expect(looksQuotaExhausted(log)).toBe(true)
})

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'retry-now-quota-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('quotaExhaustedInLog reads a log file and detects quota exhaustion', async () => {
  const log = join(dir, 'iter-0001-analyze.log')
  await writeFile(log, 'Error: anthropic account "x" returned 429\n', 'utf8')
  expect(await quotaExhaustedInLog(log)).toBe(true)
})

test('quotaExhaustedInLog is false for a clean log', async () => {
  const log = join(dir, 'iter-0002-analyze.log')
  await writeFile(log, 'analysis complete — 3 improvements applied\n', 'utf8')
  expect(await quotaExhaustedInLog(log)).toBe(false)
})

test('quotaExhaustedInLog treats a missing log as not-quota (false)', async () => {
  expect(await quotaExhaustedInLog(join(dir, 'does-not-exist.log'))).toBe(false)
})
