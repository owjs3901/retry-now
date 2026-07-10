/**
 * Agent frontends — the per-agent trigger files that configure + launch retry-now.
 *
 * opencode also ships a runtime plugin (`@retry-now/opencode`), but every agent can be wired
 * with a simple command/skill file via `retry-now install <agent>`. Formats/paths verified
 * against current docs (Claude Code v2.1.x, Codex CLI 0.118.x):
 *
 *   opencode → `.opencode/command/retry-now.md`        → `/retry-now`
 *   claude   → `.claude/commands/retry-now.md`          → `/retry-now`
 *   codex    → `.agents/skills/retry-now/SKILL.md`      → `$retry-now`
 *              (NOTE: `~/.codex/prompts/` was REMOVED in Codex ≥ 0.117.0; skills replace it,
 *               and the dir is `.agents/skills/`, NOT `.codex/skills/`.)
 *
 * The command CONDUCTS THE SETUP INTERVIEW when no config exists (scope, model, analysis,
 * direction, completion, threshold), writes `.retry-now/config.json`, and only then runs the loop — so the
 * user is always asked, never dropped straight into a run. The driver command (absolute path)
 * is baked in at install time so no global CLI install is required.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { AgentKind } from './types.ts'

export interface FrontendFile {
  /** path relative to the PROJECT root for a project-scoped install */
  readonly projectPath: string
  /** path relative to the USER HOME for a `--personal` install */
  readonly homePath: string
  /** how the user invokes it after install */
  readonly invoke: string
  /** the file content to write */
  readonly content: string
}

const RUN_HOW: Record<AgentKind, string> = {
  opencode:
    'Run exactly this command ONCE in the foreground and stream its output:',
  claude: 'Run exactly this command via the Bash tool and stream its output:',
  codex:
    'Run exactly this command and relay its complete output to the user as it streams:',
}

/** How the interviewing agent discovers the CURRENT model line-up (never hardcode one). */
const MODEL_DISCOVERY: Record<AgentKind, string> = {
  opencode:
    'run `opencode models` first — its output is the ground truth for what is available',
  claude: 'list the newest Claude models you know of (latest generation first)',
  codex: 'list the newest models you know of (latest generation first)',
}

/** Shared command body: interview-or-confirm (STEP 1) then run the loop (STEP 2). */
export function buildFrontendBody(
  agent: AgentKind,
  driverCommand: string,
): string {
  const runHow = RUN_HOW[agent]
  const runLine =
    agent === 'codex' ? driverCommand : `${driverCommand} $ARGUMENTS`
  return `retry-now (지금 바로 윤회) — CONFIGURE (if needed) then RUN the autonomous improvement loop
for THIS project. Talk to the user in their language.

TERMINOLOGY. Default to English and write "loop" — most users are English speakers — but always
match the user's language. retry-now is a reincarnation metaphor: each iteration is a brand-new life
with zero memory, and convergence is the cycle finally settling. Per language: English → "loop";
Korean → "윤회" and NEVER "루프" (NOT EVEN "윤회 루프"), e.g. "윤회를 시작합니다" / "윤회가 수렴했습니다",
with 생/환생 for one iteration and 맺어짐 for convergence; Japanese → "輪廻". Do NOT skip STEP 1.

## STEP 1 — configuration (\`.retry-now/config.json\`)

Check whether \`.retry-now/config.json\` exists in the current project.

### If it is MISSING — interview the user first, then create it.

Do NOT ask one question per turn. FIRST inspect the project silently (no questions yet): detect
whether it is a monorepo and detect its test / lint / benchmark commands. THEN ask the ENTIRE
interview AT ONCE — a SINGLE batched question listing every applicable question below in one message,
each with its recommended default pre-selected — so the user answers the whole interview in one pass
instead of one round-trip per question. Resolve the conditional questions from your inspection rather
than by asking: include the Scope question only when you detected a monorepo, and the benchRuns
follow-up only when a bench command exists.

1. **Scope (윤회 대상).** Inspect the project. If it is a monorepo — a root \`Cargo.toml\` with a
   \`[workspace] members\` table, OR a \`package.json\` with \`workspaces\` — ASK whether to run the
   loop over the **whole repo** or **per-package (분할 윤회)**. If per-package, list the member
   packages and let the user pick which ones (default: all). Otherwise the scope is the whole repo.
2. **Analysis (분석 및 계획).** What should each iteration ANALYSE and plan for?
3. **Direction (개선 방향).** Improvement priorities, conditions and constraints — what counts as
   a valid change, what is forbidden.
4. **Completion (완료 체크).** When should the loop honestly report "nothing left to improve"?
5. **Threshold (수렴 임계값).** How many CONSECUTIVE "no improvement" iterations mean converged?
   (default 5)
6. **Revert threshold (리버트 수렴 임계값).** How many CONSECUTIVE iterations whose whole change is
   reverted (a benchmark/quality regression rolled back) ALSO mean converged? (default 3) This stops
   the case where a fresh, unbiased ANALYZE keeps re-proposing a change that IMPROVE keeps reverting.
7. **Benchmark (벤치마크).** STRONGLY RECOMMEND one — it is how each iteration proves it did not
   regress speed. If detection finds none, ASK the user for a bench command (they may still decline).
   When a bench command exists, also ask how many times to repeat it before/after for a fair median
   (benchRuns, default 5; benchmarks vary by system, so more runs = fairer).
8. **Batch size (배치 크기 / improvementBatchSize).** How many independent improvements ONE iteration
   plans and applies as a batch (default 8, range 1..16). One fresh analysis is amortised over the
   whole batch — bigger = fewer iterations and less repeated analysis, but larger commits and more
   per-iteration work. \`1\` reproduces the classic one-change-per-iteration behaviour.
9. **Model (모델).** Which model id (\`provider/model\`) should every life run on? New, stronger
   models ship constantly, so ASK the user instead of assuming any specific one — and CENTER the
   choices on the LATEST models: ${MODEL_DISCOVERY[agent]}, then offer the few newest/strongest
   coding models as the options, newest first, with the strongest recommended as the default
   answer. Empty means the agent's own default model.

The loop ALWAYS also hunts and removes **duplicate code** and **dead/unused code** every iteration,
regardless of the analysis answer — that is baked into the generated prompts, so you need not ask.

Detect those test / lint / benchmark commands like so — Rust → \`cargo test\` /
\`cargo clippy --all-targets --all-features\` (clippy ALWAYS exists for Rust) / \`cargo bench\` if a
\`benches/\` dir or criterion is present; Node → \`package.json\` scripts; etc. — then WRITE
\`.retry-now/config.json\` EXACTLY in this shape:

\`\`\`json
{
  "version": 1,
  "agent": "${agent}",
  "model": "<answer 9 provider/model id, or empty string for the agent default>",
  "agentProfile": "",
  "analysis": "<answer 2>",
  "direction": "<answer 3>",
  "completion": "<answer 4>",
  "threshold": <answer 5, default 5>,
  "revertThreshold": <answer 6, default 3>,
  "maxIterations": 50,
  "skipPermissions": true,
  "commitPerIteration": true,
  "verifyEnabled": <true if a test or lint command was detected, else false>,
  "verifyTest": "<detected test command, or empty string>",
  "verifyLint": "<detected lint command, or empty string>",
  "benchCommand": "<answer 7 bench command (detected or user-provided), or empty string>",
  "benchRuns": <answer 7 runs, default 5>,
  "improvementBatchSize": <answer 8, default 8, range 1..16>,
  "targets": [<per-package: selected package paths relative to root e.g. "crates/foo"; whole-repo: []>]
}
\`\`\`

Write ONLY \`.retry-now/config.json\` — the loop regenerates everything else (prompts, .gitignore,
README) from it on the first run. Then read the config back to the user and confirm.

### If it EXISTS — summarise it (agent, model, threshold, revert-threshold, targets, verify/bench) and ASK whether to
proceed as-is or reconfigure. If they reconfigure, re-run the interview above and overwrite the file.

## STEP 2 — run the loop

${runHow}

\`\`\`bash
${runLine}
\`\`\`

The loop spawns a brand-new zero-context session each iteration and stops itself on convergence,
a \`.retry-now/STOP\` file, or the safety cap. Relay its progress (per-iteration rebirth /
streak / convergence) to the user as it appears. Do NOT modify files yourself — the loop's own
iterations do that.

Single instance & NO cross-project contention: \`.retry-now/\` is project-local, so running retry-now
on several projects at once is fine — one \`bun\` driver process per project, each isolated in its own
folder, NEVER contending. Seeing multiple driver processes is normal; do NOT kill them to "avoid a
race". A second driver on the SAME project is refused automatically via \`.retry-now/driver.lock\`, so
you never need to clean up drivers by hand.`
}

function opencodeCommand(driverCommand: string): FrontendFile {
  return {
    projectPath: '.opencode/command/retry-now.md',
    homePath: '.config/opencode/command/retry-now.md',
    invoke: '/retry-now',
    content: `---
description: retry-now — set up + run the autonomous improvement loop (지금 바로 윤회)
---

${buildFrontendBody('opencode', driverCommand)}
`,
  }
}

function claudeCommand(driverCommand: string): FrontendFile {
  return {
    projectPath: '.claude/commands/retry-now.md',
    homePath: '.claude/commands/retry-now.md',
    invoke: '/retry-now',
    content: `---
description: Set up + run the retry-now autonomous improvement loop (지금 바로 윤회)
argument-hint: "[--no-commit] [--dry-run]"
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion
---

${buildFrontendBody('claude', driverCommand)}
`,
  }
}

function codexSkill(driverCommand: string): FrontendFile {
  return {
    projectPath: '.agents/skills/retry-now/SKILL.md',
    homePath: '.agents/skills/retry-now/SKILL.md',
    invoke: '$retry-now',
    content: `---
name: retry-now
description: >
  Set up and run the retry-now loop-engineering driver (지금 바로 윤회). Use when the user types
  $retry-now or asks to start a retry loop / agent loop / retry-now session for this project.
---

${buildFrontendBody('codex', driverCommand)}
`,
  }
}

/** Build the trigger file for an agent, with the given (already absolute) driver command. */
export function buildFrontend(
  agent: AgentKind,
  driverCommand: string,
): FrontendFile {
  switch (agent) {
    case 'opencode':
      return opencodeCommand(driverCommand)
    case 'claude':
      return claudeCommand(driverCommand)
    case 'codex':
      return codexSkill(driverCommand)
  }
}

export interface FrontendInstallResult {
  readonly dest: string
  readonly invoke: string
  readonly personal: boolean
}

/**
 * Materialise an agent's trigger file with a baked driver command. `driverBase` is the command
 * that runs the loop WITHOUT `--cwd` (e.g. `bun "/abs/driver-entry.ts"` or `bun "/abs/cli" run`);
 * project installs append `--cwd "<root>"`, personal installs use the invocation-time cwd.
 */
export async function installFrontend(
  agent: AgentKind,
  driverBase: string,
  opts: { cwd?: string; personal?: boolean } = {},
): Promise<FrontendInstallResult> {
  const cwd = opts.cwd ?? process.cwd()
  const personal = opts.personal ?? false
  const driverCommand = personal ? driverBase : `${driverBase} --cwd "${cwd}"`
  const file = buildFrontend(agent, driverCommand)
  const dest = personal
    ? join(homedir(), file.homePath)
    : join(cwd, file.projectPath)
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, file.content, 'utf8')
  return { dest, invoke: file.invoke, personal }
}
