import { isSafeRepoFilePath } from './git.ts'
import { hasUnsafeTextCharacter } from './safe-text.ts'
import type { PlannedImprovement, Signal } from './types.ts'

/** Return null only when an IMPROVE signal fully accounts for the authoritative ANALYZE plan. */
export function validateImproveSignal(
  sig: Signal,
  planned: readonly PlannedImprovement[],
): string | null {
  const outcomes = sig.appliedImprovements
  if (!outcomes || outcomes.length !== planned.length) {
    return 'appliedImprovements must contain exactly one outcome per planned item'
  }
  if (sig.plannedCount !== planned.length) {
    return 'plannedCount must equal the authoritative analyze plan length'
  }

  // Matched by id only: a fresh, context-0 IMPROVE session reads the plan's title as prose to
  // act on, not a literal string it must echo back byte-for-byte, so exact-title equality here
  // would reject correct work over a harmless rewording. `id` is a short structural token
  // ("1", "2"…) that LLMs reproduce reliably across independent sessions.
  const plannedIds = new Set(planned.map((item) => item.id))
  const seen = new Set<string>()
  for (const item of outcomes) {
    if (seen.has(item.id) || !plannedIds.has(item.id)) {
      return 'every outcome must match one unique analyze plan id'
    }
    seen.add(item.id)
    if (!item.impact?.trim()) return `item ${item.id} must report impact`
    if (item.impact.length > 1000 || hasUnsafeTextCharacter(item.impact)) {
      return `item ${item.id} impact is unsafe or too long`
    }
    if (!item.decisionReason?.trim()) {
      return `item ${item.id} must report decisionReason`
    }
    if (
      item.decisionReason.length > 1000 ||
      hasUnsafeTextCharacter(item.decisionReason)
    ) {
      return `item ${item.id} decisionReason is unsafe or too long`
    }
    if (item.status === 'kept') {
      if (!item.files || item.files.length === 0) {
        return `kept item ${item.id} must report files`
      }
      for (const file of item.files) {
        if (!isSafeRepoFilePath(file)) {
          return `kept item ${item.id} reported unsafe file path`
        }
      }
    }
  }

  const counts = {
    kept: outcomes.filter((item) => item.status === 'kept').length,
    reverted: outcomes.filter((item) => item.status === 'reverted').length,
    failed: outcomes.filter((item) => item.status === 'failed').length,
    skipped: outcomes.filter((item) => item.status === 'skipped').length,
  }
  if (
    sig.keptCount !== counts.kept ||
    sig.revertedCount !== counts.reverted ||
    sig.failedCount !== counts.failed ||
    sig.skippedCount !== counts.skipped
  ) {
    return 'summary counts must exactly match appliedImprovements'
  }
  const expectedResult =
    counts.kept > 0
      ? 'applied'
      : counts.reverted > 0
        ? 'applied_reverted'
        : 'failed'
  return sig.result === expectedResult
    ? null
    : `result must be ${expectedResult} for the reported outcomes`
}
