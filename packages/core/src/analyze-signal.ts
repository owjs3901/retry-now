import { SIGNAL_LIMITS } from './limits.ts'
import { hasUnsafeTextCharacter } from './safe-text.ts'
import type { Signal } from './types.ts'

/** Return null only when an ANALYZE signal carries a policy-valid plan for its reported result. */
export function validateAnalyzeSignal(sig: Signal): string | null {
  if (sig.result !== 'improvements_found' && sig.result !== 'no_improvements') {
    return 'analyze result must be improvements_found or no_improvements'
  }

  const planned = sig.plannedImprovements
  if (
    sig.result === 'improvements_found' &&
    (!planned || planned.length === 0)
  ) {
    return 'plannedImprovements must contain at least one item when result is improvements_found'
  }
  if (!planned) return null
  // The parser deliberately no longer truncates the plan, because silently discarding item 17
  // produced exactly the false "one outcome per planned item" error this contract exists to stop.
  // The ceiling still has to hold, though: each planned item costs a fresh implement session and a
  // fresh review session, so an unbounded plan is unbounded unattended spend. Enforce it here, out
  // loud, with the measured count.
  if (planned.length > SIGNAL_LIMITS.planItems) {
    return `plannedImprovements has ${planned.length} items; the limit is ${SIGNAL_LIMITS.planItems}`
  }

  const seen = new Set<string>()
  for (const item of planned) {
    if (!/^\d{1,4}$/.test(item.id)) {
      return `planned item id "${item.id}" must contain 1 to 4 digits`
    }
    if (seen.has(item.id)) return `planned item id ${item.id} must be unique`
    seen.add(item.id)

    if (!item.title.trim()) return `planned item ${item.id} must report title`
    if (item.title.length > SIGNAL_LIMITS.title) {
      return `planned item ${item.id} title is ${item.title.length} characters; the limit is ${SIGNAL_LIMITS.title}`
    }
    if (hasUnsafeTextCharacter(item.title)) {
      return `planned item ${item.id} title is unsafe: it contains an unsafe control character or bidirectional override`
    }

    if (
      item.approach !== undefined &&
      item.approach.length > SIGNAL_LIMITS.planText
    ) {
      return `planned item ${item.id} approach is ${item.approach.length} characters; the limit is ${SIGNAL_LIMITS.planText}`
    }
    if (item.approach !== undefined && hasUnsafeTextCharacter(item.approach)) {
      return `planned item ${item.id} approach is unsafe: it contains an unsafe control character or bidirectional override`
    }

    if (
      item.verification !== undefined &&
      item.verification.length > SIGNAL_LIMITS.planText
    ) {
      return `planned item ${item.id} verification is ${item.verification.length} characters; the limit is ${SIGNAL_LIMITS.planText}`
    }
    if (
      item.verification !== undefined &&
      hasUnsafeTextCharacter(item.verification)
    ) {
      return `planned item ${item.id} verification is unsafe: it contains an unsafe control character or bidirectional override`
    }
  }

  return null
}
