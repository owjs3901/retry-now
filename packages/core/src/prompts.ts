/**
 * Prompt synthesis.
 *
 * The original `.loop` prompts were hardwired to a Rust/cargo/criterion project. retry-now
 * generalises them: the project-specific intent comes entirely from the user's config
 * (analysis / direction / completion), while the engine supplies the invariant scaffolding:
 *
 *   - the UNBIASED-ANALYZE rule (no reading of prior reports/ledger/history/state),
 *   - the one-improvement-per-iteration discipline,
 *   - the backup -> implement -> verify -> revert-on-regression safety gate,
 *   - the exact signal JSON contract.
 *
 * `stateDir` is the on-disk dir the agent reads/writes state from — `.retry-now` for a
 * whole-repo loop, or `.retry-now/targets/<slug>` for a per-package (분할) 윤회 so each target's
 * signal / reports / backups / ledger stay isolated. `scope` (when non-empty) restricts the run
 * to a single package path. These prompts are sent to the agent every reincarnation, so they
 * are written in English (fewer tokens than Korean); the user-facing CLI/theme stay Korean.
 */
import { DIR } from './paths.ts'
import type { RetryNowConfig } from './types.ts'

function signalShapeAnalyze(stateDir: string): string {
  return `{
  "iteration": <N>,
  "phase": "analyze",
  "result": "improvements_found" | "no_improvements",
  "report": "${stateDir}/reports/<PADDED>-analyze.md",
  "nextImprovement": "short title of the single chosen improvement (empty if none)",
  "summary": "1-2 sentence summary",
  "timestamp": "<ISO-8601>"
}`
}

function signalShapeImprove(stateDir: string): string {
  return `{
  "iteration": <N>,
  "phase": "improve",
  "result": "applied" | "applied_reverted" | "failed",
  "report": "${stateDir}/reports/<PADDED>-improve.md",
  "metricDelta": "measured primary delta, e.g. \\"-7.3% p50\\" or \\"none\\"",
  "summary": "1-2 sentence summary",
  "timestamp": "<ISO-8601>"
}`
}

/** Baked per-package scope block (empty for a whole-repo loop). */
function scopeSection(scope: string, what: string): string {
  if (scope === '') return ''
  return `## 0b. Scope (per-package 윤회)

This run is scoped to a SINGLE package: **${scope}**. Restrict ALL ${what} STRICTLY to that
path; ignore the rest of the repo.

---

`
}

export function buildAnalyzePrompt(
  config: RetryNowConfig,
  stateDir: string = DIR,
  scope = '',
): string {
  return `# ANALYZE PHASE — retry-now

You are a FRESH session with ZERO memory of any previous iteration (each run starts at
context 0). All cross-run state is on disk and most of it is forbidden to you.

> CRITICAL — UNBIASED ANALYSIS RULE.
> Judge the CURRENT state of the project entirely on its own merits. Do NOT read, open or grep
> any of these:
> - \`${stateDir}/reports/*\` (any earlier analysis or improvement report)
> - \`${stateDir}/ledger.md\`
> - \`${stateDir}/history.jsonl\`
> - \`${stateDir}/state.json\`
> - any earlier \`${stateDir}/logs/*\`
>
> Previous runs' conclusions MUST NOT influence whether you find improvements now.
> The current state of the code is your ONLY memory. Improvements already applied are already
> present in the code, so a genuinely fresh analysis simply will not re-propose them. The only
> files you may read from \`${stateDir}/\` are \`current.json\` (your id) and this prompt. You may
> freely read project convention docs (AGENTS.md / CLAUDE.md / README) — those are static
> project rules, not prior-iteration results.

---

## 0. Load context

1. \`${stateDir}/current.json\` — your \`iteration\` number and zero-padded \`padded\` id (e.g.
   \`0012\`), used only to name your output files.
2. Any project convention docs at the repo root (AGENTS.md / CLAUDE.md / README) — respect them.

Everything else you need comes from reading the actual project source.

---

${scopeSection(scope, 'reading and analysis')}## 1. Task — what to analyse and plan for

${config.analysis.trim()}

In ADDITION to the above, ALWAYS scan for these baseline code-quality issues — they count as valid
findings even when the task statement does not mention them:
- **Duplicate / redundant code** — the same logic copy-pasted across files, or near-identical
  functions that should be unified into ONE well-named helper. Only when it genuinely removes
  duplication — do NOT invent premature abstractions.
- **Dead / unused code** — unreferenced functions, types, variables, parameters, and imports;
  unreachable branches; permanently-disabled paths; commented-out blocks; unused dependencies.
  These should be REMOVED so the codebase stays lean.
Correctness and the priorities below still outrank pure cleanup, but a tree free of duplication and
dead code is part of what "nothing left to improve" means.

Rules:
- Ground EVERY finding in code you actually read — cite \`file:line\`.
- A finding must be concrete and actionable: exactly what to change, where, and why it helps.
- This phase is STRICTLY NON-DESTRUCTIVE. You may READ anything and run read-only observation
  commands, but you MUST NOT modify, create, delete, move, or reformat any source file, and you
  MUST NOT \`git commit\`. The only file you write is your report + the signal. Analysis only.

---

## 2. Improvement priorities (the lens you rank findings by)

${config.direction.trim()}

---

## 3. Completion criterion (when to honestly report "nothing to improve")

${config.completion.trim()}

BE HONEST. If, looking with fresh eyes, the completion criterion above is met and there is no
concrete change genuinely worth doing, emit \`no_improvements\`. The loop terminates after
${config.threshold} consecutive \`no_improvements\` runs — that honest signal is exactly how it
is meant to converge. Do NOT invent low-value busywork just to avoid saying "no".

---

## 4. Write the report

Write to \`${stateDir}/reports/<PADDED>-analyze.md\` (PADDED from \`current.json\`):
- Summary — 1-3 sentences.
- Ranked findings — for each: title, location(s) \`file:line\`, why it matters per the
  priorities above, rough effort, and a concrete change sketch.
- A \`## NEXT IMPROVEMENT\` section — pick the SINGLE best next change (highest value-to-risk,
  safe, verifiable). Describe it in enough detail that the IMPROVE phase can execute it without
  re-analysing: target files, exact approach, and how to prove it worked.

Only ONE improvement is executed per iteration so its effect stays attributable.

---

## 5. Emit the signal (MANDATORY — your LAST action)

Overwrite \`${stateDir}/signal.json\` with EXACTLY this shape (valid JSON, no comments):

\`\`\`json
${signalShapeAnalyze(stateDir)}
\`\`\`

- \`iteration\` MUST equal the number in \`current.json\`.
- \`result\` = \`"improvements_found"\` only when at least one concrete, worthwhile improvement
  exists; otherwise \`"no_improvements"\` with \`nextImprovement\` = \`""\`.
`
}

export function buildImprovePrompt(
  config: RetryNowConfig,
  stateDir: string = DIR,
  scope = '',
): string {
  const gitBlock = config.commitPerIteration
    ? `
---

## 4b. Commit this iteration's KEPT changes (git — ENABLED)

Per-iteration git commits are ON. After the decision gate, ONLY if you KEPT the change
(\`result = "applied"\`):

- Commit the files you changed for this improvement with a message PREFIXED by
  \`retry-now#<PADDED>: \` (PADDED from \`current.json\`), e.g.
  \`retry-now#0012: cache compiled regex to remove per-call allocation\`. This prefix lets the
  user identify which iteration each commit belongs to.
- You MAY create MULTIPLE commits for this one improvement if it splits naturally; give every
  one the SAME \`retry-now#<PADDED>: \` prefix.
- Commit ONLY the files you modified for this improvement. Do NOT \`git add\` the \`${DIR}/\`
  directory (it is gitignored) or unrelated pre-existing working-tree changes.
- If you REVERTED or FAILED, do NOT commit.
`
    : `
---

## 4b. Git commits — DISABLED

Per-iteration git commits are OFF for this loop. Do NOT run \`git commit\`. Leave your KEPT
changes in the working tree for the user to review and commit themselves.
`
  const benchBlock = config.benchCommand
    ? `This project HAS a benchmark — you MUST measure it. Run exactly:

\`\`\`bash
${config.benchCommand}
\`\`\`

Benchmarks vary run-to-run with system load, so a single before/after pair is NOT trustworthy.
Run the command ${config.benchRuns} times BEFORE the change and take the MEDIAN (note the spread).
After the change, run it ${config.benchRuns} times again and take the median the same way. Speed is
the TOP priority, so compare MEDIANS: if the after-median is clearly WORSE than the before-median
beyond the run-to-run noise you observed, that is a REGRESSION and you MUST REVERT. If it is better
or within the noise band (statistically neutral), it is acceptable to keep. Report both medians, the
% delta and the observed noise in metricDelta and the report.`
    : `This project has NO benchmark command configured — strongly suboptimal, because a performance
regression can then slip in unmeasured. Capture the most meaningful OBJECTIVE baseline you can for
THIS change (wall-clock timing of the hot path, output size, allocation count) and measure it the
SAME way ${config.benchRuns}x before and after; treat a clear regression as grounds to REVERT. If
the change is pure cleanup (e.g. dead-code removal) with no measurable runtime effect, say so.`
  const hasVerify =
    config.verifyEnabled &&
    (config.verifyTest !== '' || config.verifyLint !== '')
  const verifyBlock = hasVerify
    ? `## 3b. Step 3 — verify this iteration ran cleanly (REQUIRED)

After implementing, run these EXACT commands. They are this iteration's completion check:
${config.verifyTest ? `- test: \`${config.verifyTest}\`\n` : ''}${config.verifyLint ? `- lint: \`${config.verifyLint}\`\n` : ''}
If ANY fails, the change is NOT acceptable: restore every file from \`${stateDir}/backups/<PADDED>/\`,
re-confirm the build, and set \`result\` to \`"applied_reverted"\` (a working change you rolled
back) or \`"failed"\` (could not reach green). KEEP only when every command above passes.`
    : `## 3b. Step 3 — verify (no automated test/lint configured)

This project has no test/lint command configured for the loop (the user accepted proceeding
without one). Confirm the change is correct and self-consistent by re-reading it and the
directly-related code before keeping it.`
  return `# IMPROVE PHASE — retry-now

You are a FRESH session with NO memory of prior iterations. This phase runs only because the
ANALYZE phase of THIS iteration found an improvement. All state is on disk.

---

## 0. Load context (this iteration only)

1. \`${stateDir}/current.json\` — your \`iteration\` and zero-padded \`padded\` id.
2. \`${stateDir}/signal.json\` — the analyze result; \`nextImprovement\` names your target.
3. \`${stateDir}/reports/<PADDED>-analyze.md\` — THIS iteration's analysis. Its
   \`## NEXT IMPROVEMENT\` section is your exact spec.
4. Project convention docs at the repo root (AGENTS.md / CLAUDE.md / README).

Do not browse older reports/ledger — everything you need is this iteration's analyze report.
Execute exactly ONE improvement so the measured effect is attributable to a single change.

---

${scopeSection(scope, 'changes and measurement')}## 1. Measure BEFORE (baseline)

${benchBlock}

### Improvement priorities

${config.direction.trim()}

---

## 2. Back up, then implement

- Back up first: COPY every file you will modify into \`${stateDir}/backups/<PADDED>/\`,
  preserving relative paths. This is your ONLY revert source — the loop deliberately does NOT
  use git for revert, so it never disturbs unrelated working-tree changes.
- Implement EXACTLY the one improvement from the analyze spec. Smallest correct change. No
  suppressed warnings, no type-escape casts, no unjustified unsafe operations. Obey the
  project's convention docs.
- Keep it green: the project's build + lint + tests for every touched area must pass.

---

## 3. Measure AFTER

Re-run the SAME measurement from step 1 and compare against the baseline.

---

${verifyBlock}

---

## 4. Decision gate — follow the priority order in the improvement priorities above

- The primary priority REGRESSED → REVERT: restore every file from \`${stateDir}/backups/<PADDED>/\`,
  re-verify the build is green. \`result = "applied_reverted"\`.
- Improved or statistically neutral AND all checks pass → KEEP. \`result = "applied"\`.
- Could not complete safely (build/tests won't go green) → revert, \`result = "failed"\`.

A pure quality change with a neutral primary metric may be KEPT. Never keep anything that
regresses the top priority. Always leave the build GREEN and the working tree consistent.
${gitBlock}
---

## 5. Append to the ledger (human-facing; NOT read by analyze)

Append ONE row to \`${stateDir}/ledger.md\`:

\`| <PADDED> | <improvement title> | applied / reverted / failed | <delta> | <files touched> |\`

---

## 6. Write the improvement report

Write \`${stateDir}/reports/<PADDED>-improve.md\`: what changed, files touched, before/after key
numbers, and the decision + reason.

---

## 7. Emit the signal (MANDATORY — LAST action)

Overwrite \`${stateDir}/signal.json\` with EXACTLY:

\`\`\`json
${signalShapeImprove(stateDir)}
\`\`\`

- \`result\` is one of \`"applied"\` | \`"applied_reverted"\` | \`"failed"\`.
- \`metricDelta\` is the measured primary delta (or \`"none"\`).
- \`iteration\` MUST equal \`current.json\`.
`
}
