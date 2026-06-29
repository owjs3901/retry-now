/**
 * `@retry-now/core` analyze-prompt resilience guidance — the signal-write guarantee.
 *
 * A freshly-spawned ANALYZE agent reads every in-scope crate (correct) and then, on a
 * near-clean tree, runs clippy "to confirm findings before writing the report"; that extra
 * verification ends the turn (exit 0, not a crash) BEFORE §5, so `signal.json` stays the
 * driver's `pending` placeholder, `readSignal()` returns null, and the loop fails to error.
 * `buildAnalyzePrompt` is regenerated into `analyze.md` every run, so the fix lives there:
 * the prompt must (1) keep demanding FULL, exhaustive source coverage, (2) forbid running
 * build/test/lint/clippy to "confirm" findings in this read-only phase, and (3) make emitting
 * the signal the single non-negotiable terminal obligation with a budget last-resort rule.
 *
 * These tests lock that guidance in while proving the protected pieces — the §5 signal JSON
 * contract, the UNBIASED-ANALYSIS rule, the BATCH PLAN discipline, and the read-only guarantee
 * — survive byte-for-byte, and that the change never leaks a false-convergence path or touches
 * the IMPROVE prompt.
 */
import { expect, test } from 'bun:test'

import { buildAnalyzePrompt, buildImprovePrompt } from '../prompts.ts'
import type { RetryNowConfig } from '../types.ts'

function cfg(overrides: Partial<RetryNowConfig> = {}): RetryNowConfig {
  return {
    version: 1,
    agent: 'opencode',
    model: '',
    agentProfile: '',
    analysis: 'ANALYSIS_SENTINEL',
    direction: 'DIRECTION_SENTINEL',
    completion: 'COMPLETION_SENTINEL',
    threshold: 3,
    revertThreshold: 3,
    maxIterations: 100,
    skipPermissions: true,
    commitPerIteration: true,
    verifyEnabled: true,
    verifyTest: 'bun test',
    verifyLint: 'bun run lint',
    benchCommand: '',
    benchRuns: 5,
    improvementBatchSize: 3,
    targets: [],
    ...overrides,
  }
}

test('analyze prompt preserves FULL, exhaustive source coverage (never instructs sampling/skipping)', () => {
  const out = buildAnalyzePrompt(cfg())
  expect(out).toContain('Read ALL in-scope source EXHAUSTIVELY')
  expect(out).toContain('do NOT sample, skip, or shortcut files')
  expect(out).toContain('must NOT be reduced')
})

test('analyze prompt forbids running build/test/lint/clippy to "confirm findings" in this read-only phase', () => {
  const out = buildAnalyzePrompt(cfg())
  expect(out).toContain('Do NOT run build/test/lint/clippy')
  expect(out).toContain('to confirm')
  // names the observed failure mode so the guidance is not silently weakened later.
  expect(out).toContain('budget-killer')
})

test('analyze prompt makes the signal the single non-negotiable terminal obligation, written immediately', () => {
  const out = buildAnalyzePrompt(cfg())
  expect(out).toContain('SINGLE NON-NEGOTIABLE terminal obligation')
  expect(out).toContain('write them IMMEDIATELY')
  expect(out).toContain('before ANY optional')
})

test('analyze prompt carries the budget last-resort rule to emit the signal NOW with current findings', () => {
  const out = buildAnalyzePrompt(cfg())
  expect(out).toContain('LAST RESORT')
  // substring stays on one line — the prompt wraps "already\nhave" at the column limit.
  expect(out).toContain('emit this signal NOW with the findings you already')
})

test('the last-resort rule forbids a false-convergence write (truncated run must NOT become no_improvements)', () => {
  const out = buildAnalyzePrompt(cfg())
  expect(out).toContain(
    'NEVER record a budget-truncated run as `no_improvements`',
  )
})

test('the §5 signal JSON contract and the analyze result enum values are preserved unchanged', () => {
  const out = buildAnalyzePrompt(cfg())
  // signalShapeAnalyze, byte-for-byte.
  expect(out).toContain('"phase": "analyze"')
  expect(out).toContain('"result": "improvements_found" | "no_improvements"')
  expect(out).toContain('"plannedImprovements": [')
  // the field-contract bullets after the JSON.
  expect(out).toContain('`iteration` MUST equal the number in `current.json`.')
})

test('the UNBIASED-ANALYSIS rule, BATCH PLAN discipline and read-only guarantee remain intact', () => {
  const out = buildAnalyzePrompt(cfg())
  expect(out).toContain('UNBIASED ANALYSIS RULE')
  expect(out).toContain('## BATCH PLAN')
  expect(out).toContain('STRICTLY NON-DESTRUCTIVE')
})

test('analyze prompt treats small-but-real wins as worth capturing, not "low-value busywork"', () => {
  const out = buildAnalyzePrompt(cfg())
  expect(out).toContain('Small impact is not zero impact')
  expect(out).toContain('MUST be captured')
  // convergence bar is raised: no_improvements is honest only when no win of any size is left.
  expect(out).toContain('ANY size remains')
})

test('analyze prompt counts a pure code-quality gain (zero runtime/memory delta) as worth doing', () => {
  const out = buildAnalyzePrompt(cfg())
  expect(out).toContain('CODE-QUALITY gain')
  expect(out).toContain('Code quality is itself a valid payoff')
})

test('analyze prompt guards correctness/completeness against an edge-case-risky micro-trade', () => {
  const out = buildAnalyzePrompt(cfg())
  expect(out).toContain(
    'Do NOT trade correctness, completeness, or generality for a micro-gain',
  )
  // the user's canonical example: a partial JSON parser is a regression, not a win.
  expect(out).toContain('special-case JSON parser')
})

test('the new guidance is analyze-only — the IMPROVE prompt is not touched', () => {
  const improve = buildImprovePrompt(cfg())
  expect(improve).not.toContain('SINGLE NON-NEGOTIABLE terminal obligation')
  expect(improve).not.toContain('Read ALL in-scope source EXHAUSTIVELY')
  expect(improve).not.toContain('budget-killer')
  expect(improve).not.toContain(
    'Do NOT trade correctness, completeness, or generality for a micro-gain',
  )
})

test('a non-empty scope injects the per-package scope block into both prompts', () => {
  const analyze = buildAnalyzePrompt(cfg(), '.retry-now', 'packages/core')
  const improve = buildImprovePrompt(cfg(), '.retry-now', 'packages/core')
  expect(analyze).toContain('## 0b. Scope (per-package')
  expect(analyze).toContain('packages/core')
  expect(improve).toContain('## 0b. Scope (per-package')
  // whole-repo (empty scope) renders no scope block
  expect(buildAnalyzePrompt(cfg())).not.toContain('## 0b. Scope (per-package')
})

test('improve prompt renders the opposite branches: commits OFF, benchmark present, no verify', () => {
  const out = buildImprovePrompt(
    cfg({
      commitPerIteration: false,
      benchCommand: 'cargo bench',
      benchRuns: 7,
      verifyEnabled: false,
      verifyTest: '',
      verifyLint: '',
    }),
  )
  expect(out).toContain('Git commits — DISABLED')
  expect(out).toContain('This project HAS a benchmark')
  expect(out).toContain('no automated test/lint configured')
})
