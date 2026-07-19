/**
 * Detect the `/retry-now` slash command completing so the plugin can start the loop itself — with
 * NO agent-callable tool. opencode emits a `command.executed` event ({ name, sessionID }) for every
 * command regardless of the active agent, exactly like the `session.idle` events oh-my-openagent's
 * ralph-loop is driven by. A curated orchestrator agent (e.g. Sisyphus) filters out
 * plugin-registered TOOLS, but never these bus events — so reacting to the event, instead of asking
 * the agent to call `retrynow_start`, makes `/retry-now` work from ANY agent.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * The `sessionID` of a `command.executed` event for `commandName`, or `undefined` when the event is
 * something else / malformed. The returned session becomes the loop's parent session, so each phase
 * nests under the session where the command ran and stays observable in the TUI.
 */
export function retryNowCommandSessionID(
  event: unknown,
  commandName = 'retry-now',
): string | undefined {
  if (!isRecord(event) || event.type !== 'command.executed') return undefined
  const properties = event.properties
  if (!isRecord(properties)) return undefined
  if (properties.name !== commandName) return undefined
  return typeof properties.sessionID === 'string'
    ? properties.sessionID
    : undefined
}

/**
 * Whether the event is a `session.idle` — the turn-completed signal (same one ralph-loop rides). We
 * defer the actual loop start to idle so `.retry-now/config.json` is guaranteed written first (the
 * command's STEP 1 interview finishes within the turn), independent of when `command.executed`
 * fires relative to the turn.
 */
export function isSessionIdleEvent(event: unknown): boolean {
  return isRecord(event) && event.type === 'session.idle'
}
