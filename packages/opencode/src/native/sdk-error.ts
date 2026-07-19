/**
 * SDK-level error classification for the opencode-native backend.
 *
 * A blocking `session.prompt` turn surfaces its failure as `AssistantMessage.error` — the
 * installed @opencode-ai/sdk union `ProviderAuthError | UnknownError | MessageOutputLengthError |
 * MessageAbortedError | ApiError` (types.gen.d.ts:106). The driver needs the same distinction it
 * draws for a spawned CLI: a rate-limit / quota wall must PAUSE the loop (retrying just burns the
 * next account), while everything else is a crash to retry in a fresh session.
 *
 * Classification is deliberately structural — it narrows `unknown` with type guards rather than
 * importing the SDK types — so these helpers stay pure and standalone and survive SDK field
 * drift. The textual markers mirror `@retry-now/core`'s `quota.ts` so both detection paths (the
 * driver's log scan and this structured-error seam) share one narrow definition of "out of
 * quota".
 */

/**
 * Runtime rate-limit / quota markers, mirrored by hand from `@retry-now/core`'s `quota.ts` (these
 * helpers must not import core). Each matches a rendered ERROR shape, never a bare keyword, so a
 * provider message that merely mentions rate limiting does not false-fire.
 */
const QUOTA_MARKERS: readonly RegExp[] = [
  /\baccount\s+"[^"\n]{1,80}"\s+returned\s+(?:429|402|403)\b/i,
  /\bno usable account\b/i,
  /AI_(?:API(?:Call)?|Retry)Error[^\n]{0,160}(?:rate.?limit|\b429\b|too many requests|quota|usage limit)/i,
  /\b(?:rate limit exceeded|too many requests|usage limit reached|quota exceeded|insufficient_quota)\b/i,
]

/** True when `value` is a non-null object — the shape every SDK error member shares. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Join the human-readable fields (`message`, `responseBody`) of an SDK error's `data` payload. */
function errorText(data: Record<string, unknown>): string {
  const parts: string[] = []
  if (typeof data.message === 'string') parts.push(data.message)
  if (typeof data.responseBody === 'string') parts.push(data.responseBody)
  return parts.join('\n')
}

/**
 * Classify an `AssistantMessage.error` value into the driver's two outcomes.
 *
 * Returns `'quota'` when the error clearly indicates a rate-limit / quota wall: an `ApiError`
 * (its `name` is the string `"APIError"`) carrying HTTP `429`, or any member whose rendered
 * message matches the quota markers above. Every other value — auth failures, aborts,
 * output-length limits, unknown shapes, and `undefined`/`null` — is `'crash'`.
 */
export function classifySdkError(error: unknown): 'quota' | 'crash' {
  if (!isRecord(error)) return 'crash'
  const data = isRecord(error.data) ? error.data : undefined
  // An `ApiError` with an HTTP 429 status is the definitive rate-limit signal.
  if (error.name === 'APIError' && data?.statusCode === 429) return 'quota'
  // Otherwise fall back to the rendered provider message: a canonical quota phrase means the
  // same wall even when no numeric status field is present.
  if (data !== undefined) {
    const text = errorText(data)
    if (text.length > 0 && QUOTA_MARKERS.some((marker) => marker.test(text))) {
      return 'quota'
    }
  }
  return 'crash'
}
