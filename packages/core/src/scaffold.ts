/**
 * Scaffolding: materialise the `.retry-now/` runtime directory inside a target project.
 *
 * Idempotent. `config.json` is written once (init owns it) but the derived prompt files,
 * README, ledger header and `.gitignore` are always (re)generated so editing the config and
 * re-running keeps the prompts in sync.
 */
import { ensureDir, exists, writeJson, writeText } from './io.ts'
import type { Paths } from './paths.ts'
import { DIR, resolvePaths } from './paths.ts'
import { buildAnalyzePrompt, buildImprovePrompt } from './prompts.ts'
import type { RetryNowConfig } from './types.ts'

/**
 * Write the analyze + improve prompts for a given paths/stateDir/scope. Shared by `scaffold`
 * (root, whole-repo) and the driver (per-target, scoped). `stateDirRel` is the on-disk dir the
 * agent reads/writes from (e.g. `.retry-now` or `.retry-now/targets/<slug>`); `scope` is the
 * package path for a per-package loop (or "" for whole-repo).
 */
export async function writePrompts(
  paths: Paths,
  config: RetryNowConfig,
  stateDirRel: string,
  scope: string,
): Promise<void> {
  await ensureDir(paths.promptsDir)
  await writeText(
    paths.analyzePrompt,
    buildAnalyzePrompt(config, stateDirRel, scope),
  )
  await writeText(
    paths.improvePrompt,
    buildImprovePrompt(config, stateDirRel, scope),
  )
}

export const LEDGER_HEADER = `# Improvement Ledger (human-facing history)

> Human-facing summary of every change the IMPROVE phase attempted.
> **Intentionally NOT read by the ANALYZE phase** — analyze must judge the *current* state
> freshly, without bias from prior lives. Applied improvements live in the code itself, so a
> fresh analysis naturally won't re-propose them.

| Iter | Improvement | Outcome | Metric delta | Files |
|------|-------------|---------|--------------|-------|
`

function runtimeReadme(config: RetryNowConfig): string {
  const verifyDesc =
    config.verifyEnabled &&
    (config.verifyTest !== '' || config.verifyLint !== '')
      ? `run verification after each improve phase; revert on failure (test: ${config.verifyTest || '-'}, lint: ${config.verifyLint || '-'})`
      : 'no automated test/lint configured; the agent must self-check related code'
  const benchDesc = config.benchCommand
    ? `${config.benchCommand} (before/after median of ${config.benchRuns} runs; revert on regression)`
    : 'not configured (recommended)'
  return `# .retry-now runtime state

Runtime state for retry-now. **Everything here is git-ignored** by an inner ".gitignore" containing "*".

**Project-local — no cross-project contention.** This folder belongs to THIS project alone; a driver only ever reads/writes here. Running retry-now on several projects at once is fine and expected — one \`bun\` driver process per project, each isolated in its own \`.retry-now/\`, so they NEVER contend. Do NOT kill "extra" driver processes just because you see several — they are different projects. Only a SECOND driver on the SAME project would contend, and \`driver.lock\` already prevents that (a stale lock left by a killed run is reclaimed automatically).

Core rule: every iteration starts a fresh \`${config.agent}\` session with context reset to zero.
Analyze model: \`${config.analysisModel || config.model || 'agent default'}\`. Improve model: \`${config.improveModel || config.model || 'agent default'}\`.
Only \`state.json\` carries driver-owned streaks across iterations. ANALYZE must not read prior reports, ledger, history, state, or old logs.

Each ANALYZE phase plans up to \`${config.improvementBatchSize}\` independently revertible items in one unbiased pass.
IMPROVE executes items sequentially with no implementation parallelism: one item, one fresh sub-implementation agent/session when available, backup -> edit -> verify -> keep/revert.
This amortizes one analysis across the batch while keeping each item benchmarkable and reportable. (\`improvementBatchSize = 1\` restores classic one-item behavior.)

The loop converges after \`${config.threshold}\` consecutive \`no_improvements\` ANALYZE runs, or \`${config.revertThreshold}\` consecutive IMPROVE runs that keep zero items. Safety cap: \`maxIterations = ${config.maxIterations}\`.

git commits: ${config.commitPerIteration ? '**on** — the driver creates one `retry-now#NNNN:` commit per iteration with `<applied>/<planned>` in the subject and per-item impact/evidence/rejection reasons in the body.' : '**off** — leave kept changes in the working tree.'}

step1 ANALYZE is strictly read-only. step3 verification: ${verifyDesc}.
Benchmark: ${benchDesc}. A final \`summary.md\` is generated when the loop stops.

## Files
| Path | Purpose |
|---|---|
| \`config.json\` | Static user intent; not prior-run bias. |
| \`prompts/analyze.md\` | Generated ANALYZE prompt. |
| \`prompts/improve.md\` | Generated IMPROVE prompt. |
| \`state.json\` | Driver state; never fed into ANALYZE. |
| \`current.json\` | Current iteration/phase hint. |
| \`signal.json\` | Agent-to-driver signal, overwritten each phase. |
| \`history.jsonl\` | Append-only machine log. |
| \`ledger.md\` | Human-facing attempted-change ledger. |
| \`reports/NNNN-*.md\` | Per-phase reports. |
| \`backups/NNNN/\` | IMPROVE backups for item-level revert. |
| \`logs/iter-NNNN-*.log\` | Raw agent stdout/stderr. |
| \`STOP\` | Create to stop at the next boundary. |
| \`driver.lock\` | Single-instance guard (pid). Prevents a 2nd driver on THIS project; a stale one is reclaimed. |

## Stop / resume / reset
- Stop: create \`.retry-now/STOP\`.
- Resume: delete STOP if present, then rerun the driver.
- Reset: delete \`state.json\`, or set iteration/streak to 0 and status to "running".
`
}

/**
 * Create or refresh the runtime directory. Returns resolved paths.
 *
 * @param writeConfig when true, (over)writes config.json. init passes true; the driver
 *        passes false so it never clobbers user config, only refreshes derived files.
 */
export async function scaffold(
  root: string,
  config: RetryNowConfig,
  writeConfig = false,
): Promise<Paths> {
  const paths = resolvePaths(root)

  for (const d of [
    paths.dir,
    paths.promptsDir,
    paths.reportsDir,
    paths.logsDir,
  ]) {
    await ensureDir(d)
  }

  // The whole runtime dir is local-only: a single `*` ignores everything inside the folder
  // (this `.gitignore` itself included), so git never tracks `.retry-now/`. The project's root
  // `.gitignore` is intentionally left untouched — the inner ignore already fully covers it.
  await writeText(paths.gitignore, '*\n')

  if (writeConfig || !(await exists(paths.config))) {
    await writeJson(paths.config, config)
  }

  // Always regenerate derived artifacts from the (possibly updated) config.
  await writePrompts(paths, config, DIR, '')
  await writeText(paths.readme, runtimeReadme(config))

  if (!(await exists(paths.ledger))) {
    await writeText(paths.ledger, LEDGER_HEADER)
  }

  return paths
}
