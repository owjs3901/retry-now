/**
 * Agent → driver one-way signal channel.
 *
 * Before each phase the driver writes a `pending` signal so a crashed/silent agent run is
 * detectable. The agent overwrites it as its LAST action. The driver then validates that
 * the signal matches the expected iteration+phase before trusting it.
 */
import { isSafeRepoFilePath } from './git.ts'
import { nowIso, readJson, writeJson } from './io.ts'
import { SIGNAL_LIMITS } from './limits.ts'
import type { Paths } from './paths.ts'
import { pad } from './paths.ts'
import type {
  AppliedImprovement,
  BatchItemStatus,
  Current,
  ImproveStage,
  Phase,
  PlannedImprovement,
  Signal,
} from './types.ts'

export { validateAnalyzeSignal } from './analyze-signal.ts'
export { validateImproveSignal } from './improve-signal.ts'

/** Reset the signal to `pending` and publish the per-reincarnation hint. */
export async function beginPhase(
  paths: Paths,
  iteration: number,
  phase: Phase,
  target?: string,
  item?: { readonly id: string; readonly stage: ImproveStage },
): Promise<void> {
  const current: Current = {
    iteration,
    padded: pad(iteration),
    phase,
    ...(target !== undefined && target !== '' ? { target } : {}),
    ...(item ? { itemId: item.id, stage: item.stage } : {}),
  }
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

function optPlanText(v: unknown): string | undefined {
  const text = optStr(v)?.trim()
  return text !== undefined && text !== '' ? text : undefined
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
    // DELIBERATELY the STRICT predicate — the one place that keeps it. `targetFiles` is the only
    // path list the loop merely REPEATS as advice: it is rendered into the implement prompt
    // (`improve-prompts.ts`) and is never a pathspec, a filesystem path, or part of a transaction, so
    // it is also the only path list accepted purely on the agent's word, with nothing downstream to
    // corroborate it. Every path list the driver ACTS on (snapshot, commit, restore, delete) uses the
    // relaxed `isSafeGitListedPath` instead, because there a rejected path aborts real work.
    //
    // KNOWN LIMITATION, accepted: a Next.js/SvelteKit/Remix route path such as
    // `app/blog/[slug]/page.tsx` is dropped from this advisory list, so a plan item consisting only
    // of such files carries no `targetFiles` and the implement prompt falls back to its placeholder
    // example path. Nothing else degrades — `validateAnalyzeSignal` never requires `targetFiles`, the
    // item's title/approach/verification carry the actual instruction, and the item's own kept files
    // are validated by the relaxed predicate — so the loop still runs and commits normally on those
    // repositories.
    const targetFiles = Array.isArray(item.targetFiles)
      ? [
          ...new Set(
            item.targetFiles
              .filter((file): file is string => typeof file === 'string')
              .map((file) => file.replace(/\\/g, '/'))
              .filter(isSafeRepoFilePath),
          ),
        ].slice(0, SIGNAL_LIMITS.targetFiles)
      : []
    const approach = optPlanText(item.approach)
    const verification = optPlanText(item.verification)
    out.push({
      id,
      title,
      ...(isRisk(item.risk) ? { risk: item.risk } : {}),
      ...(targetFiles.length > 0 ? { targetFiles } : {}),
      ...(approach !== undefined ? { approach } : {}),
      ...(verification !== undefined ? { verification } : {}),
    })
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
    const impact = optStr(item.impact)
    const decisionReason = optStr(item.decisionReason)
    const metricDelta = optStr(item.metricDelta)
    const summary = optStr(item.summary)
    const files = Array.isArray(item.files)
      ? item.files
          .filter((f): f is string => typeof f === 'string')
          .map((file) => file.replace(/\\/g, '/'))
      : undefined
    out.push({
      id,
      title,
      status: item.status,
      ...(impact !== undefined ? { impact } : {}),
      ...(decisionReason !== undefined ? { decisionReason } : {}),
      ...(metricDelta !== undefined ? { metricDelta } : {}),
      ...(files ? { files } : {}),
      ...(summary !== undefined ? { summary } : {}),
    })
  }
  return out
}

/**
 * Structural decoding gate for the agent→driver signal — the boundary twin of `normalizeConfig`.
 * The signal is untrusted JSON the agent wrote (and a crashed agent may write half of it), so this
 * choke point accepts only values whose JSON types can form a trustworthy `Signal`.
 *
 * Hard fields (`iteration`/`phase`/`result`) must be valid or the whole signal is rejected
 * (returns null → the driver retries the phase in a fresh session). Optional values with the wrong
 * JSON type are omitted, but well-typed text is never deleted for requiredness, length, unsafe
 * characters, or id format: those are POLICY owned by `validateAnalyzeSignal` and
 * `validateImproveSignal`. Keeping the supplied value lets those validators report its measured
 * length and exact violation, instead of turning real agent evidence into a false "must report"
 * reason that a fresh retry cannot act on.
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
  const plannedCount = optCount(raw.plannedCount)
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
    ...(plannedCount !== undefined ? { plannedCount } : {}),
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
 * The union of files touched by every KEPT batch item — the driver's exact commit scope.
 *
 * The driver validates these paths against the pre-IMPROVE dirty baseline and current exact file
 * status before staging them. A structured signal with a kept item but no files is rejected.
 */
export function keptFilesOf(sig: Signal): string[] {
  const files = new Set<string>()
  for (const item of sig.appliedImprovements ?? []) {
    if (item.status !== 'kept') continue
    for (const f of item.files ?? []) files.add(f)
  }
  return [...files]
}
