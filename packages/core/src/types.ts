/**
 * retry-now — shared types.
 *
 * The whole system communicates across context-zero reincarnations through small
 * on-disk files. These types are the contract for every one of those files plus the
 * user-facing configuration.
 */

/** Which headless coding agent the driver spawns each reincarnation. */
export type AgentKind = 'opencode' | 'codex' | 'claude'

/** The two phases of a single iteration (윤회 한 생). */
export type Phase = 'analyze' | 'improve'

/**
 * User-authored configuration, collected once by `retry-now init` (or written by hand).
 * This is the ONLY place project-specific intent lives — the engine itself is generic.
 *
 * Lives at `.retry-now/config.json`. Safe to read at any phase (it is static intent,
 * not prior-iteration results, so it does not bias the unbiased ANALYZE phase).
 */
export interface RetryNowConfig {
  /** schema marker for forward-compat */
  readonly version: 1
  /** which agent CLI drives each reincarnation */
  readonly agent: AgentKind
  /** optional explicit model id (provider/model); empty = agent default */
  readonly model: string
  /** optional agent profile name (opencode `--agent`); empty = default */
  readonly agentProfile: string
  /**
   * 1. 분석 및 계획 — WHAT to analyse and plan for. Becomes the ANALYZE task body.
   * e.g. "Analyse all code under src/ for runtime performance and correctness issues."
   */
  readonly analysis: string
  /**
   * 2. 개선 방향 — HOW to improve: priorities, constraints, guardrails. Drives IMPROVE.
   * e.g. "Speed > memory > readability. Never break tests. Smallest correct change only."
   */
  readonly direction: string
  /**
   * 3. 완료 체크 — how to judge "더 개선할 게 없다". Injected into the ANALYZE signal
   * decision so the agent emits `no_improvements` honestly when this condition holds.
   * e.g. "Nothing to improve when all benchmarks are within noise and clippy is clean."
   */
  readonly completion: string
  /**
   * 수렴 임계값. The number the user types: how many CONSECUTIVE `no_improvements`
   * reincarnations must occur before we declare 맺어짐 (converged / perfect).
   */
  readonly threshold: number
  /**
   * 리버트 수렴 임계값. How many CONSECUTIVE iterations whose change was NOT kept
   * (`applied_reverted` or `failed`) before we ALSO declare 맺어짐. Guards the case where a fresh,
   * unbiased ANALYZE keeps re-proposing the same change that IMPROVE keeps reverting on a
   * benchmark regression — without it that pair would loop until `maxIterations`.
   */
  readonly revertThreshold: number
  /** hard safety cap on total iterations regardless of streak. */
  readonly maxIterations: number
  /** pass --dangerously-skip-permissions / equivalent for unattended runs. */
  readonly skipPermissions: boolean
  /**
   * Default true. Commit each 윤회's KEPT changes via git so the user can review every
   * iteration. The agent commits with a `retry-now#<PADDED>:` prefix (multiple commits per
   * iteration are allowed); reverted/failed iterations are NOT committed.
   */
  readonly commitPerIteration: boolean
  /**
   * Step-3 (완료 체크) verification. When `verifyEnabled` and a command is set, the IMPROVE
   * phase runs it after applying a change and REVERTS if it fails — this is how each 윤회 is
   * confirmed to have run cleanly. Commands are detected at init (`@retry-now/detect`); "" = none.
   */
  readonly verifyEnabled: boolean
  readonly verifyTest: string
  readonly verifyLint: string
  /**
   * Benchmark command. If non-empty, IMPROVE MUST measure BEFORE and AFTER and report the
   * delta (speed/throughput is the top priority). "" = no benchmark available.
   */
  readonly benchCommand: string
  /**
   * How many times IMPROVE repeats the benchmark BEFORE and AFTER a change so the comparison is
   * fair despite system noise — compare MEDIANS, treat a change within run-to-run noise as
   * neutral. Default 5. Ignored when `benchCommand` is "".
   */
  readonly benchRuns: number
  /**
   * Per-package 윤회 targets — paths relative to root (e.g. "crates/vespera_core"). EMPTY = a
   * single loop over the whole repo. Non-empty (monorepo split mode) = one INDEPENDENT loop per
   * target, each converging on its own and scoped to that path. Chosen at init for monorepos.
   */
  readonly targets: readonly string[]
}

/** Terminal status of the loop. */
export type LoopStatus =
  | 'running'
  | 'stopped-converged' // streak reached threshold — 맺어졌다
  | 'stopped-manual' // STOP sentinel / Ctrl+C
  | 'stopped-maxiter' // safety cap hit
  | 'error' // agent failed to signal twice

/**
 * Driver-owned control state. The driver is the SOLE owner of the cross-reincarnation
 * counter. Lives at `.retry-now/state.json`. NEVER fed back into the ANALYZE prompt.
 */
export interface LoopState {
  status: LoopStatus
  iteration: number
  /** consecutive `no_improvements` count — the only thing that survives reincarnation. */
  noImprovementStreak: number
  threshold: number
  /** consecutive iterations whose improvement was NOT kept (`applied_reverted`/`failed`). */
  revertStreak: number
  revertThreshold: number
  startedAt: string
  updatedAt: string
}

/** Result codes an ANALYZE phase may emit. */
export type AnalyzeResult = 'improvements_found' | 'no_improvements' | 'pending'

/** Result codes an IMPROVE phase may emit. */
export type ImproveResult =
  | 'applied'
  | 'applied_reverted'
  | 'failed'
  | 'pending'

/**
 * One-way signal: agent → driver. Overwritten every phase. Lives at
 * `.retry-now/signal.json`. The driver resets it to `pending` before each run so a
 * crashed/silent agent is detectable.
 */
export interface Signal {
  iteration: number
  phase: Phase
  result: AnalyzeResult | ImproveResult
  /** path to the human-facing report this phase wrote */
  report: string
  /** ANALYZE only: short title of the single chosen next improvement */
  nextImprovement?: string
  /** IMPROVE only: measured primary metric delta (free text), e.g. "-7.3% p50" */
  metricDelta?: string
  summary: string
  timestamp: string
}

/** Per-reincarnation hint handed to the agent. Lives at `.retry-now/current.json`. */
export interface Current {
  iteration: number
  /** zero-padded id used to name output files, e.g. "0012" */
  padded: string
  phase: Phase
  /** when set, this life is scoped to a single package path (per-package 윤회) */
  target?: string
}

/** Options passed to the driver (mostly sourced from config, overridable per run). */
export interface DriverOptions {
  /** project root that the loop operates on (where `.retry-now/` lives) */
  readonly cwd: string
  /** if true, simulate one cycle without spawning any agent process */
  readonly dryRun: boolean
  /** optional progress sink; defaults to console */
  readonly log?: (line: string) => void
}
