/**
 * Quota-exhaustion detection for the loop driver.
 *
 * When EVERY account / credential the agent can use is out of quota (429 / rate-limit), the
 * agent run dies WITHOUT writing a signal — by exit code alone that is indistinguishable from a
 * crash. But the two need opposite handling: a crash should be retried in a fresh session, while
 * a quota wall makes retrying pointless (on a load balancer it just burns the next account too).
 * The driver uses this module to tell them apart so it can PAUSE cleanly (status `paused-quota`)
 * — and, with `waitForQuota`, wait for the quota to refill and resume — instead of spending its
 * crash-retries and stopping with a misleading `error`.
 *
 * Detection scans the agent's own log for DISTINCTIVE runtime rate-limit / quota error shapes.
 * It is deliberately narrow because a self-improvement loop frequently runs ON code that is
 * *about* rate limiting (this very project is one): the markers must NOT fire on a test name
 * like "rotates on 429", a `grep "429"`, or a source comment mentioning "rate-limited / over
 * quota". Each marker therefore matches a rendered ERROR shape — a quoted account that
 * "returned 429", an SDK error class named with a rate-limit cause, or a full canonical
 * rate-limit phrase — never a bare keyword.
 */
import { readText } from './io.ts'

const QUOTA_MARKERS: readonly RegExp[] = [
  // Load-balancer per-account throw, e.g. `anthropic account "work" returned 429`. The quoted
  // label + `returned` + a 4xx status is the runtime shape; a template-literal source
  // (`returned ${res.status}`) has no digit and a test name has no quoted label, so neither
  // false-matches.
  /\baccount\s+"[^"\n]{1,80}"\s+returned\s+(?:429|402|403)\b/i,
  // Load-balancer all-accounts-exhausted throw, e.g. `... no usable account in the ... pool`.
  /\bno usable account\b/i,
  // AI SDK provider error, but ONLY when it names a rate-limit / quota cause — so a
  // context-length or other APICallError is not misread as quota (waiting would never clear it).
  /AI_(?:API(?:Call)?|Retry)Error[^\n]{0,160}(?:rate.?limit|\b429\b|too many requests|quota|usage limit)/i,
  // Canonical provider quota / rate-limit phrases. Full phrases only, never bare words, so
  // "rate-limited account" (a test name) or "over quota" (a comment) do not match.
  /\b(?:rate limit exceeded|too many requests|usage limit reached|quota exceeded|insufficient_quota)\b/i,
]

/**
 * True when `text` contains a runtime rate-limit / quota-exhaustion error marker. Pure and
 * keyword-narrow on purpose (see the module doc): it must distinguish a real provider 429 from
 * a codebase that merely talks about 429s.
 */
export function looksQuotaExhausted(text: string): boolean {
  return QUOTA_MARKERS.some((marker) => marker.test(text))
}

/**
 * Read an agent log file and report whether it shows a quota-exhaustion error. A missing or
 * unreadable log is treated as "not quota" (`false`) so detection never invents a pause.
 */
export async function quotaExhaustedInLog(logPath: string): Promise<boolean> {
  const text = await readText(logPath)
  return text !== null && looksQuotaExhausted(text)
}
