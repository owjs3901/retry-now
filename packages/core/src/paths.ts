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

export interface Paths {
  readonly root: string // absolute project root
  readonly dir: string // <root>/.retry-now
  readonly gitignore: string
  readonly config: string
  readonly state: string
  readonly signal: string
  readonly current: string
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
  return {
    key,
    current: join(itemsDir, `${key}.current.json`),
    signal: join(itemsDir, `${key}.signal.json`),
    prompt: join(itemsDir, `${key}.prompt.md`),
    report: join(paths.reportsDir, `${key}.md`),
    log: join(paths.logsDir, `${key}.log`),
    backupDir: join(
      stateDir,
      'backups',
      pad(iteration),
      `item-${itemNumber}-${safeId}`,
    ),
  }
}
