/**
 * Canonical layout of the `.retry-now/` runtime directory inside a target project.
 *
 * Everything the loop reads/writes resolves through here so the path scheme has exactly
 * one source of truth (and the opencode plugin, the CLI driver, and the agent prompts all
 * agree).
 */
import { dirname, join } from 'node:path'

import type { ImproveStage } from './types.ts'

export const DIR = '.retry-now'

/**
 * Name of the manifest, inside an item's backup directory, listing the repository-relative paths
 * that item CREATED (one per line).
 *
 * Backups are written by the AGENT, not the driver, so this name is a contract that only holds if
 * the prompt states it — `buildItemImplementPrompt` renders this exact constant, and
 * `restoreItemBackup` reads it, so the two can never drift. A rollback needs it because restoring
 * pre-existing files cannot possibly undo a file that did not exist before: without the manifest an
 * item's new files would survive its own rollback.
 */
export const NEW_FILES_MANIFEST = 'NEW_FILES.txt'

export interface Paths {
  readonly root: string // absolute project root
  readonly dir: string // <root>/.retry-now
  readonly gitignore: string
  readonly config: string
  readonly state: string
  readonly signal: string
  readonly current: string
  /**
   * Driver-owned record of the IMPROVE transaction currently in flight, written when a life's
   * per-item work starts and superseded when the next one starts. It exists so that a driver killed
   * mid-batch leaves behind the one fact `retry-now recover` cannot reconstruct from anything else:
   * the Git HEAD the batch was supposed to keep immutable. NOT agent-visible.
   */
  readonly iterationRecord: string
  readonly history: string // append-only jsonl
  readonly ledger: string
  readonly summary: string // final comprehensive loop report
  readonly stop: string // STOP sentinel
  readonly headQuarantine: string // project-level unauthorized-HEAD quarantine
  readonly driverLock: string // single-instance guard (project-level, shared across targets)
  readonly readme: string
  readonly promptsDir: string
  readonly analyzePrompt: string
  readonly improvePrompt: string
  readonly reportsDir: string
  readonly logsDir: string
}

export interface ImproveItemPaths {
  readonly key: string
  readonly current: string
  readonly signal: string
  readonly prompt: string
  readonly report: string
  readonly log: string
  readonly backupDir: string
  /** `<backupDir>/NEW_FILES.txt` — the manifest of paths this item created */
  readonly newFiles: string
}

/** Convert a target path to a filesystem-safe slug, e.g. "crates/vespera_core" -> "crates__vespera_core". */
export function slugifyTarget(target: string): string {
  return target.replace(/[/\\]+/g, '__').replace(/[^a-zA-Z0-9._-]/g, '_')
}

/**
 * Resolve all `.retry-now/` paths for `root`. When `targetSlug` is given (per-package 윤회),
 * the STATEFUL files (state/signal/current/history/ledger/summary/reports/logs) live under
 * `.retry-now/targets/<slug>/`, while the SHARED files (config/prompts/gitignore/readme/STOP)
 * stay at `.retry-now/` so every target uses the same prompts and a single STOP sentinel.
 */
export function resolvePaths(root: string, targetSlug?: string): Paths {
  const dir = join(root, DIR)
  const stateDir = targetSlug ? join(dir, 'targets', targetSlug) : dir
  return {
    root,
    dir,
    gitignore: join(dir, '.gitignore'),
    config: join(dir, 'config.json'),
    readme: join(dir, 'README.md'),
    promptsDir: join(stateDir, 'prompts'),
    analyzePrompt: join(stateDir, 'prompts', 'analyze.md'),
    improvePrompt: join(stateDir, 'prompts', 'improve.md'),
    stop: join(dir, 'STOP'),
    headQuarantine: join(dir, 'HEAD_CHANGED.json'),
    driverLock: join(dir, 'driver.lock'),
    state: join(stateDir, 'state.json'),
    signal: join(stateDir, 'signal.json'),
    current: join(stateDir, 'current.json'),
    iterationRecord: join(stateDir, 'iteration.json'),
    history: join(stateDir, 'history.jsonl'),
    ledger: join(stateDir, 'ledger.md'),
    summary: join(stateDir, 'summary.md'),
    reportsDir: join(stateDir, 'reports'),
    logsDir: join(stateDir, 'logs'),
  }
}

/** zero-pad an iteration number to a 4-wide id, e.g. 12 -> "0012". */
export function pad(iteration: number): string {
  return String(iteration).padStart(4, '0')
}

export function resolveImproveItemPaths(
  paths: Paths,
  iteration: number,
  planIndex: number,
  stage: ImproveStage,
  itemId: string,
): ImproveItemPaths {
  const safeId = itemId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40) || 'item'
  const itemNumber = String(planIndex + 1).padStart(2, '0')
  const key = `${pad(iteration)}-${itemNumber}-${stage}-${safeId}`
  const stateDir = dirname(paths.state)
  const itemsDir = join(stateDir, 'items')
  // Both stages of one item share ONE backup directory: the implement stage fills it and the review
  // stage restores from it, so the key deliberately excludes `stage`. This is what makes "item K's
  // backup == HEAD + items 1..K-1" true, and therefore what lets a rollback of item K strip exactly
  // item K's changes even when an earlier item touched the same file.
  const backupDir = join(
    stateDir,
    'backups',
    pad(iteration),
    `item-${itemNumber}-${safeId}`,
  )
  return {
    key,
    current: join(itemsDir, `${key}.current.json`),
    signal: join(itemsDir, `${key}.signal.json`),
    prompt: join(itemsDir, `${key}.prompt.md`),
    report: join(paths.reportsDir, `${key}.md`),
    log: join(paths.logsDir, `${key}.log`),
    backupDir,
    newFiles: join(backupDir, NEW_FILES_MANIFEST),
  }
}
