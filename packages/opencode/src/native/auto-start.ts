/**
 * Starts the retry-now loop from the `/retry-now` command with NO agent-callable tool, so it works
 * from ANY agent (a curated orchestrator like oh-my-openagent's Sisyphus filters out
 * plugin-registered tools but never the bus events this rides).
 *
 * Two events cooperate, making the start immune to when `command.executed` fires relative to the
 * command turn:
 *  - `command.executed` (name === "retry-now") records the PARENT session so each phase nests under
 *    the session where `/retry-now` ran.
 *  - `session.idle` (the turn-completed signal ralph-loop also uses) is when we actually attempt the
 *    start, so the command's STEP 1 interview has already written `.retry-now/config.json`.
 *
 * `attempt` is idempotent: `start` no-ops when no config exists yet or a loop is already running, so
 * a pending start simply waits for the next idle until config is ready, then clears.
 */
export interface AutoStartDeps {
  /** Launch the loop for `parentSessionID`; no-ops when config is missing or a loop already runs. */
  readonly start: (parentSessionID: string) => Promise<void>
  /** Whether a loop is currently active for this directory (used to confirm a start took hold). */
  readonly isActive: () => boolean
  /** Best-effort logger for unexpected start failures. */
  readonly log?: (line: string) => void
}

export class AutoStartCoordinator {
  private pending: string | undefined

  constructor(private readonly deps: AutoStartDeps) {}

  /** Record the parent session from `/retry-now`, then try to start (covers config-already-present). */
  async onCommandExecuted(parentSessionID: string): Promise<void> {
    this.pending = parentSessionID
    await this.attempt()
  }

  /** On turn completion, try the pending start (covers first-run: config written during the turn). */
  async onIdle(): Promise<void> {
    await this.attempt()
  }

  private async attempt(): Promise<void> {
    const parentSessionID = this.pending
    if (parentSessionID === undefined) return
    try {
      await this.deps.start(parentSessionID)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.deps.log?.(`retry-now auto-start failed: ${detail}`)
    }
    // Clear only once the loop actually took hold; otherwise keep waiting for a later idle
    // (e.g. the interview has not written config yet).
    if (this.deps.isActive()) this.pending = undefined
  }
}
