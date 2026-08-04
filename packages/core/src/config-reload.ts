/**
 * Life-boundary config reload.
 *
 * A 윤회 runs for hours or days, so `config.json` is edited WHILE the driver is running — most often
 * to raise `maxIterations` or retune a convergence threshold after watching a few lives. Loading the
 * config exactly once at startup made those edits vanish without a word: no effect, no warning, and
 * the only way to apply them was a full stop/restart that threw away the life in flight.
 *
 * So the driver re-reads the config at every life boundary. It does NOT re-apply everything, because
 * most fields are not safe to change underneath a running loop (see `PINNED_FIELD_REASONS`). Exactly
 * the loop-control counters in `RELOADABLE_FIELDS` are re-applied; every other changed field is
 * reported as deliberately pinned, with the reason, so a silent no-op is impossible in either
 * direction. The reload happens BETWEEN lives, never inside one, so no life ever sees its own
 * control values change mid-flight.
 */
import { loadConfig } from './config.ts'
import type { RetryNowConfig } from './types.ts'

/**
 * The only fields a life boundary re-applies. All three are pure loop-control counters the driver
 * reads at the top of a life and nowhere else, so re-applying them cannot invalidate work already
 * done, artifacts already written, or evidence already recorded.
 */
export const RELOADABLE_FIELDS = [
  'maxIterations',
  'threshold',
  'revertThreshold',
] as const satisfies readonly (keyof RetryNowConfig)[]

export type ReloadableField = (typeof RELOADABLE_FIELDS)[number]

const GENERIC_PINNED_REASON =
  'not a loop-control counter, so it is not in the life-boundary reload allowlist'

/**
 * Why a changed field is deliberately NOT re-applied mid-run. These are not oversights: each one
 * would invalidate something a running loop has already committed to, so it takes effect on the
 * next `retry-now run` instead.
 */
const PINNED_FIELD_REASONS: Partial<Record<keyof RetryNowConfig, string>> = {
  targets:
    'targets decides which independent loops exist and each one owns a separate state directory; changing it mid-run would strand or duplicate that state',
  improvementBatchSize:
    'the running life already sized its plan and laid out per-item backup directories under the old value',
  analysis:
    'the prompts were synthesized at run start; changing intent mid-run would make one life answer two different briefs',
  direction:
    'the prompts were synthesized at run start; changing intent mid-run would make one life answer two different briefs',
  completion:
    'the prompts were synthesized at run start; changing intent mid-run would make one life answer two different briefs',
  verifyEnabled:
    'verification is the gate this life\u2019s items were already judged against; changing it mid-run would make one life\u2019s verdicts incomparable',
  verifyTest:
    'verification is the gate this life\u2019s items were already judged against; changing it mid-run would make one life\u2019s verdicts incomparable',
  verifyLint:
    'verification is the gate this life\u2019s items were already judged against; changing it mid-run would make one life\u2019s verdicts incomparable',
  benchCommand:
    'the benchmark baseline was measured with the old command, so a mid-run swap would compare unlike numbers',
  benchRuns:
    'the benchmark baseline was measured with the old run count, so a mid-run swap would compare unlike numbers',
  commitPerIteration:
    'commit mode fixes the clean-worktree precondition and the attribution baseline this life started under',
}

/** One field whose on-disk value differs from the value the running loop is using. */
export interface ConfigChange {
  readonly field: keyof RetryNowConfig
  readonly from: string
  readonly to: string
}

/** A changed field that stays pinned for the rest of this run, and why. */
export interface PinnedConfigChange extends ConfigChange {
  readonly reason: string
}

export interface ConfigReload {
  /** the config the next life must use: `active` with allowlisted changes folded in */
  readonly config: RetryNowConfig
  /**
   * The config as it now reads ON DISK, to carry into the next comparison.
   *
   * This is tracked separately from `config` because the running config is NOT the file: CLI flags
   * like `--no-commit` are layered on top of it. Diffing the layered config against the file would
   * report the user's own override as an on-disk change, once per life, forever — so the comparison
   * is always file-against-file, and only the allowlisted result is folded into the running config.
   */
  readonly onDisk: RetryNowConfig
  /** allowlisted fields that changed on disk and WERE re-applied */
  readonly applied: readonly ConfigChange[]
  /** fields that changed on disk but stay pinned for this run */
  readonly pinned: readonly PinnedConfigChange[]
  /**
   * Set when the config could not be re-read (deleted, unparseable, or newly invalid). The active
   * config is kept unchanged — a broken edit must never take down a healthy long-running loop.
   */
  readonly issue: string | null
}

/**
 * Read the on-disk config as a comparison baseline WITHOUT ever throwing.
 *
 * `loadConfig` returns null for a missing/unparseable file but THROWS `ConfigError` for a file that
 * parses yet violates a constraint (e.g. `maxIterations: 0`). A long-running loop must not die
 * because of a config it is not even going to apply, so every failure degrades to `fallback` — the
 * values the run started with.
 */
export async function loadConfigBaseline(
  root: string,
  fallback: RetryNowConfig,
  load: (root: string) => Promise<RetryNowConfig | null> = loadConfig,
): Promise<RetryNowConfig> {
  try {
    return (await load(root)) ?? fallback
  } catch {
    return fallback
  }
}

/** Render a value for a human-readable reload log line. */
function show(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

const RELOADABLE = new Set<string>(RELOADABLE_FIELDS)

/**
 * Fold the allowlisted fields of `next` into `active`. Written as explicit named fields rather than
 * a dynamic key copy so the type checker proves only these three are reassignable;
 * `config-reload.test.ts` pins this against `RELOADABLE_FIELDS`.
 */
function applyReloadable(
  active: RetryNowConfig,
  next: RetryNowConfig,
): RetryNowConfig {
  return {
    ...active,
    maxIterations: next.maxIterations,
    threshold: next.threshold,
    revertThreshold: next.revertThreshold,
  }
}

/**
 * Split the change the USER made on disk into re-applied and pinned, and fold the re-applied part
 * into the running config.
 *
 * `previousOnDisk` and `next` are both file contents, so the diff describes only what the user
 * edited. `active` is the running config, which may additionally carry CLI overrides; it receives the
 * allowlisted values but is never itself compared.
 */
export function diffLoopConfig(
  active: RetryNowConfig,
  previousOnDisk: RetryNowConfig,
  next: RetryNowConfig,
): Omit<ConfigReload, 'issue'> {
  const applied: ConfigChange[] = []
  const pinned: PinnedConfigChange[] = []
  const fields = new Set<string>([
    ...Object.keys(previousOnDisk),
    ...Object.keys(next),
  ])
  for (const field of [...fields].sort()) {
    const key = field as keyof RetryNowConfig
    if (sameValue(previousOnDisk[key], next[key])) continue
    const change: ConfigChange = {
      field: key,
      from: show(previousOnDisk[key]),
      to: show(next[key]),
    }
    if (RELOADABLE.has(field)) {
      applied.push(change)
      continue
    }
    pinned.push({
      ...change,
      reason: PINNED_FIELD_REASONS[key] ?? GENERIC_PINNED_REASON,
    })
  }
  return {
    config: applied.length === 0 ? active : applyReloadable(active, next),
    onDisk: next,
    applied,
    pinned,
  }
}

/**
 * Re-read `config.json` for `root` and resolve the config the next life should use. A config that
 * has become unreadable or invalid is reported via `issue` and the active config is kept, so a
 * half-saved edit cannot kill a loop that has been running for hours.
 */
export async function reloadLoopConfig(
  root: string,
  active: RetryNowConfig,
  previousOnDisk: RetryNowConfig,
  load: (root: string) => Promise<RetryNowConfig | null> = loadConfig,
): Promise<ConfigReload> {
  let next: RetryNowConfig | null
  try {
    next = await load(root)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      config: active,
      onDisk: previousOnDisk,
      applied: [],
      pinned: [],
      issue: `config.json could not be re-read (${message}); keeping the values this run started with`,
    }
  }
  if (next === null) {
    return {
      config: active,
      onDisk: previousOnDisk,
      applied: [],
      pinned: [],
      issue:
        'config.json is missing, unparseable, or no longer valid; keeping the values this run started with',
    }
  }
  return { ...diffLoopConfig(active, previousOnDisk, next), issue: null }
}

/** Human-readable log lines for a reload. Empty when nothing changed and nothing went wrong. */
export function reloadLogLines(reload: ConfigReload): string[] {
  const lines: string[] = []
  if (reload.issue !== null) lines.push(`  ! config reload: ${reload.issue}`)
  for (const change of reload.applied) {
    lines.push(
      `  config reloaded: ${change.field} ${change.from} -> ${change.to}`,
    )
  }
  for (const change of reload.pinned) {
    lines.push(
      `  config pinned for this run: ${change.field} ${change.from} -> ${change.to} is NOT applied — ${change.reason}. Restart to apply it.`,
    )
  }
  return lines
}
