/**
 * Agent → driver one-way signal channel.
 *
 * Before each phase the driver writes a `pending` signal so a crashed/silent agent run is
 * detectable. The agent overwrites it as its LAST action. The driver then validates that
 * the signal matches the expected iteration+phase before trusting it.
 */
import { nowIso, readJson, writeJson } from './io.ts'
import type { Paths } from './paths.ts'
import { pad } from './paths.ts'
import type {
  AppliedImprovement,
  BatchItemStatus,
  Current,
  Phase,
  PlannedImprovement,
  Signal,
} from './types.ts'

/** Reset the signal to `pending` and publish the per-reincarnation hint. */
export async function beginPhase(
  paths: Paths,
  iteration: number,
  phase: Phase,
  target?: string,
): Promise<void> {
  const current: Current =
    target !== undefined && target !== ''
      ? { iteration, padded: pad(iteration), phase, target }
      : { iteration, padded: pad(iteration), phase }
  await writeJson(paths.current, current)
  const pending: Signal = {
    iteration,
    phase,
    result: 'pending',
    report: '',
    summary: '',
    timestamp: nowIso(),
  }
  await writeJson(paths.signal, pending)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function isPhase(v: unknown): v is Phase {
  return v === 'analyze' || v === 'improve'
}

function isResult(v: unknown): v is Signal['result'] {
  return (
    v === 'improvements_found' ||
    v === 'no_improvements' ||
    v === 'applied' ||
    v === 'applied_reverted' ||
    v === 'failed' ||
    v === 'pending'
  )
}

function isStatus(v: unknown): v is BatchItemStatus {
  return v === 'kept' || v === 'reverted' || v === 'failed' || v === 'skipped'
}

function isRisk(v: unknown): v is 'low' | 'medium' | 'high' {
  return v === 'low' || v === 'medium' || v === 'high'
}

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/** A count is trustworthy only when it is a finite, non-negative integer. */
function optCount(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
    ? Math.trunc(v)
    : undefined
}

/** Drop any plan item that lacks a string id+title; keep a valid `risk` when present. */
function cleanPlanned(v: unknown): PlannedImprovement[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: PlannedImprovement[] = []
  for (const item of v) {
    if (!isRecord(item)) continue
    const id = optStr(item.id)
    const title = optStr(item.title)
    if (id === undefined || title === undefined) continue
    out.push(isRisk(item.risk) ? { id, title, risk: item.risk } : { id, title })
  }
  return out
}

/** Drop any applied item missing a string id+title or a valid status; clean its optionals. */
function cleanApplied(v: unknown): AppliedImprovement[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: AppliedImprovement[] = []
  for (const item of v) {
    if (!isRecord(item)) continue
    const id = optStr(item.id)
    const title = optStr(item.title)
    if (id === undefined || title === undefined) continue
    if (!isStatus(item.status)) continue
    const metricDelta = optStr(item.metricDelta)
    const summary = optStr(item.summary)
    const files = Array.isArray(item.files)
      ? item.files.filter((f): f is string => typeof f === 'string')
      : undefined
    out.push({
      id,
      title,
      status: item.status,
      ...(metricDelta !== undefined ? { metricDelta } : {}),
      ...(files ? { files } : {}),
      ...(summary !== undefined ? { summary } : {}),
    })
  }
  return out
}

/**
 * Parse-don't-validate gate for the agent→driver signal — the boundary twin of
 * `normalizeConfig`. The signal is untrusted JSON the agent wrote (and a crashed agent may write
 * half of it), so this is the single choke point that turns it into a trustworthy `Signal`.
 *
 * Hard fields (`iteration`/`phase`/`result`) must be valid or the whole signal is rejected
 * (returns null → the driver retries the phase in a fresh session). The optional batch fields are
 * CLEANED rather than rejected — malformed plan/applied items and non-numeric counts are dropped —
 * so one stray field never throws away an otherwise-usable signal.
 */
export function normalizeSignal(raw: unknown): Signal | null {
  if (!isRecord(raw)) return null
  const iteration = raw.iteration
  if (typeof iteration !== 'number' || !Number.isFinite(iteration)) return null
  const phase = raw.phase
  if (!isPhase(phase)) return null
  const result = raw.result
  if (!isResult(result)) return null

  const nextImprovement = optStr(raw.nextImprovement)
  const planned = cleanPlanned(raw.plannedImprovements)
  const metricDelta = optStr(raw.metricDelta)
  const applied = cleanApplied(raw.appliedImprovements)
  const keptCount = optCount(raw.keptCount)
  const revertedCount = optCount(raw.revertedCount)
  const failedCount = optCount(raw.failedCount)
  const skippedCount = optCount(raw.skippedCount)

  return {
    iteration: Math.trunc(iteration),
    phase,
    result,
    report: asStr(raw.report),
    summary: asStr(raw.summary),
    timestamp: asStr(raw.timestamp),
    ...(nextImprovement !== undefined ? { nextImprovement } : {}),
    ...(planned ? { plannedImprovements: planned } : {}),
    ...(metricDelta !== undefined ? { metricDelta } : {}),
    ...(applied ? { appliedImprovements: applied } : {}),
    ...(keptCount !== undefined ? { keptCount } : {}),
    ...(revertedCount !== undefined ? { revertedCount } : {}),
    ...(failedCount !== undefined ? { failedCount } : {}),
    ...(skippedCount !== undefined ? { skippedCount } : {}),
  }
}

/**
 * Read the signal the agent emitted and validate it. Returns null when the run produced
 * no valid signal (still pending, mismatched iteration/phase, or unparseable/malformed) — the
 * driver treats that as a failed run.
 */
export async function readSignal(
  paths: Paths,
  iteration: number,
  phase: Phase,
): Promise<Signal | null> {
  const sig = normalizeSignal(await readJson<unknown>(paths.signal))
  if (!sig) return null
  if (sig.result === 'pending') return null
  if (sig.iteration !== iteration) return null
  if (sig.phase !== phase) return null
  return sig
}

/**
 * How many batch items an IMPROVE phase actually KEPT — the driver's single progress measure.
 *
 * A batch can be a partial success (some items kept, some reverted), so `result` alone is no
 * longer enough to decide whether real progress happened. The per-item `appliedImprovements`
 * list is the source of truth; `keptCount` is used when only the summary number was emitted;
 * and a legacy single-change signal (neither field present) maps `result === 'applied'` → 1.
 */
export function keptCountOf(sig: Signal): number {
  if (Array.isArray(sig.appliedImprovements)) {
    return sig.appliedImprovements.filter((i) => i.status === 'kept').length
  }
  if (typeof sig.keptCount === 'number' && Number.isFinite(sig.keptCount)) {
    return Math.max(0, Math.trunc(sig.keptCount))
  }
  return sig.result === 'applied' ? 1 : 0
}

/**
 * The union of files touched by every KEPT batch item — the driver's commit-fallback scope.
 *
 * When an IMPROVE agent kept changes but failed to commit them, these are the ONLY paths the
 * driver stages, so the fallback commits exactly the kept work and never sweeps unrelated
 * working-tree changes. Empty when no kept item reported files (the fallback then commits nothing
 * and the leftover is surfaced by the driver's end-of-loop clean-tree warning instead).
 */
export function keptFilesOf(sig: Signal): string[] {
  const files = new Set<string>()
  for (const item of sig.appliedImprovements ?? []) {
    if (item.status !== 'kept') continue
    for (const f of item.files ?? []) files.add(f)
  }
  return [...files]
}
