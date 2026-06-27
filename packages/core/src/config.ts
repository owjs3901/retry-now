/**
 * Config defaults, normalisation and validation.
 *
 * `init` collects raw user input; everything else in the engine consumes a fully-validated
 * `RetryNowConfig`. Keep this the single choke point so the driver never sees a half-formed
 * config (e.g. threshold = 0, which would "converge" instantly).
 */
import { readJson } from './io.ts'
import { resolvePaths } from './paths.ts'
import type { AgentKind, RetryNowConfig } from './types.ts'

export const AGENT_KINDS: readonly AgentKind[] = ['opencode', 'codex', 'claude']

/** Type guard for `AgentKind`. Use at JSON/CLI boundaries instead of `as AgentKind`. */
export function isAgentKind(value: unknown): value is AgentKind {
  return (
    typeof value === 'string' &&
    (AGENT_KINDS as readonly string[]).includes(value)
  )
}

export const DEFAULT_THRESHOLD = 5
export const DEFAULT_MAX_ITERATIONS = 50
export const DEFAULT_REVERT_THRESHOLD = 3
export const DEFAULT_BENCH_RUNS = 5
export const DEFAULT_IMPROVEMENT_BATCH_SIZE = 3
/** Hard bounds on the batch size: 1 (original single-change behaviour) .. 8. */
export const MIN_IMPROVEMENT_BATCH_SIZE = 1
export const MAX_IMPROVEMENT_BATCH_SIZE = 8

export const DEFAULTS: RetryNowConfig = {
  version: 1,
  agent: 'opencode',
  model: '',
  agentProfile: '',
  analysis: '',
  direction: '',
  completion: '',
  threshold: DEFAULT_THRESHOLD,
  revertThreshold: DEFAULT_REVERT_THRESHOLD,
  maxIterations: DEFAULT_MAX_ITERATIONS,
  skipPermissions: true,
  commitPerIteration: true,
  verifyEnabled: false,
  verifyTest: '',
  verifyLint: '',
  benchCommand: '',
  benchRuns: DEFAULT_BENCH_RUNS,
  improvementBatchSize: DEFAULT_IMPROVEMENT_BATCH_SIZE,
  targets: [],
}

export class ConfigError extends Error {}

function int(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value))
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Normalise + validate raw input into a trustworthy config (throws on hard errors). */
export function normalizeConfig(raw: Partial<RetryNowConfig>): RetryNowConfig {
  const agentRaw = raw.agent ?? DEFAULTS.agent
  if (!isAgentKind(agentRaw)) {
    throw new ConfigError(
      `agent must be one of ${AGENT_KINDS.join(', ')} (got "${String(raw.agent)}")`,
    )
  }
  const agent: AgentKind = agentRaw

  const analysis = str(raw.analysis, '').trim()
  const direction = str(raw.direction, '').trim()
  const completion = str(raw.completion, '').trim()
  if (!analysis)
    throw new ConfigError('analysis (분석 및 계획) must not be empty')
  if (!direction)
    throw new ConfigError('direction (개선 방향) must not be empty')
  if (!completion)
    throw new ConfigError('completion (완료 체크) must not be empty')

  const threshold = int(raw.threshold, DEFAULT_THRESHOLD)
  if (threshold < 1)
    throw new ConfigError('threshold (수렴 임계값) must be >= 1')

  const revertThreshold = int(raw.revertThreshold, DEFAULT_REVERT_THRESHOLD)
  if (revertThreshold < 1)
    throw new ConfigError('revertThreshold (리버트 수렴 임계값) must be >= 1')

  const maxIterations = int(raw.maxIterations, DEFAULT_MAX_ITERATIONS)
  if (maxIterations < 1) throw new ConfigError('maxIterations must be >= 1')

  const benchRuns = int(raw.benchRuns, DEFAULT_BENCH_RUNS)
  if (benchRuns < 1) throw new ConfigError('benchRuns must be >= 1')

  // Clamp (not throw): an out-of-range batch size is a harmless tuning knob, so a stray value
  // degrades to the nearest legal one rather than failing the whole loop. `1` = original behaviour.
  const improvementBatchSize = clamp(
    int(raw.improvementBatchSize, DEFAULT_IMPROVEMENT_BATCH_SIZE),
    MIN_IMPROVEMENT_BATCH_SIZE,
    MAX_IMPROVEMENT_BATCH_SIZE,
  )

  return {
    version: 1,
    agent,
    model: str(raw.model, '').trim(),
    agentProfile: str(raw.agentProfile, '').trim(),
    analysis,
    direction,
    completion,
    threshold,
    revertThreshold,
    maxIterations,
    skipPermissions: bool(raw.skipPermissions, true),
    commitPerIteration: bool(raw.commitPerIteration, true),
    verifyEnabled: bool(raw.verifyEnabled, false),
    verifyTest: str(raw.verifyTest, '').trim(),
    verifyLint: str(raw.verifyLint, '').trim(),
    benchCommand: str(raw.benchCommand, '').trim(),
    benchRuns,
    improvementBatchSize,
    targets: Array.isArray(raw.targets)
      ? raw.targets
          .filter((t): t is string => typeof t === 'string')
          .map((t) => t.trim().replace(/\\/g, '/').replace(/\/+$/, ''))
          .filter((t) => t !== '')
      : [],
  }
}

/** Load + validate the on-disk config for a project. Returns null if none exists. */
export async function loadConfig(root: string): Promise<RetryNowConfig | null> {
  const paths = resolvePaths(root)
  const raw = await readJson<Partial<RetryNowConfig>>(paths.config)
  if (!raw) return null
  return normalizeConfig(raw)
}
