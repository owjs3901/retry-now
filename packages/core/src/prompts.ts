/**
 * Prompt synthesis.
 *
 * The original `.loop` prompts were hardwired to a Rust/cargo/criterion project. retry-now
 * generalises them: the project-specific intent comes entirely from the user's config
 * (analysis / direction / completion), while the engine supplies the invariant scaffolding:
 *
 *   - the UNBIASED-ANALYZE rule (no reading of prior reports/ledger/history/state),
 *   - the bounded BATCH-PLAN discipline (one fresh analysis amortised over up to
 *     `improvementBatchSize` independently-revertible items),
 *   - the per-item backup -> implement -> checkpoint-verify -> revert-on-regression safety gate,
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
  "nextImprovement": "short title of the FIRST plan item (empty if none)",
  "plannedImprovements": [
    { "id": "1", "title": "<title of item 1>", "risk": "low" },
    { "id": "2", "title": "<title of item 2>", "risk": "low" }
  ],
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
  "appliedImprovements": [
    { "id": "1", "title": "<item 1 title>", "status": "kept", "files": ["path/a.ts"] },
    { "id": "2", "title": "<item 2 title>", "status": "reverted", "summary": "why it was rolled back" }
  ],
  "keptCount": <number kept>,
  "revertedCount": <number reverted>,
  "failedCount": <number failed>,
  "skippedCount": <number skipped>,
  "metricDelta": "primary delta of the benchmark item, or a short batch note, or \\"none\\"",
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
- Read ALL in-scope source EXHAUSTIVELY. The findings worth shipping are micro-level, so they only
  surface once you have read everything — do NOT sample, skip, or shortcut files. Full coverage is
  required and must NOT be reduced; it is exactly why this phase exists.
- Ground EVERY finding in code you actually read — cite \`file:line\`.
- A finding must be concrete and actionable: exactly what to change, where, and why it helps.
- Do NOT trade correctness, completeness, or generality for a micro-gain. A change that wins a few
  bytes or nanoseconds but stops handling inputs the current code handles is a REGRESSION, not an
  improvement — e.g. a smaller special-case JSON parser that no longer accepts every valid JSON the
  full parser does. When a "smaller/faster" rewrite risks many uncovered edge cases, keep the
  complete, spec-correct implementation and do NOT propose the trade.
- This phase is STRICTLY NON-DESTRUCTIVE. You may READ anything and run read-only observation
  commands, but you MUST NOT modify, create, delete, move, or reformat any source file, and you
  MUST NOT \`git commit\`. The only file you write is your report + the signal. Analysis only.
- Do NOT run build/test/lint/clippy (or any compile / typecheck / format check) "to confirm
  findings". This phase is READ-ONLY: reading the source is enough to ground a finding, and proving
  it is the IMPROVE phase's job. That redundant verification is the #1 budget-killer — it ends the
  turn before you reach §5, leaving the signal unwritten.

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

But "small" is NOT "worthless", and a real win does NOT need a runtime/memory number. A change that
saves a few bytes, nanoseconds, or one allocation — AND a pure CODE-QUALITY gain with no measurable
runtime effect at all (clearer, simpler, less duplicated, less dead code) — are BOTH genuine
improvements that MUST be captured. Code quality is itself a valid payoff, so PROCEED even when the
speed/memory delta is exactly zero. Never drop a finding because its payoff is tiny or unmeasurable.
Small impact is not zero impact, so improve EVERY fine-grained thing you can and let none slip. The
only busywork to avoid is a change that leaves the code NO better at all — cosmetic churn that does
not improve clarity, or speculative abstraction that adds indirection without removing real
duplication; reserve \`no_improvements\` for a tree where no real win of ANY size remains.

---

## 4. Write the report

Write to \`${stateDir}/reports/<PADDED>-analyze.md\` (PADDED from \`current.json\`):
- Summary — 1-3 sentences.
- Ranked findings — for each: title, location(s) \`file:line\`, why it matters per the
  priorities above, rough effort, and a concrete change sketch.
- A \`## BATCH PLAN\` section — pick the BEST ${config.improvementBatchSize} next changes (or
  fewer if fewer worthwhile ones exist), ordered best-first by value-to-risk. This single fresh
  analysis is amortised over the whole batch instead of being thrown away after one pick, so be
  generous but disciplined: include only changes that are concrete, safe and verifiable.
  - Number the items \`1.\`, \`2.\`, … — these ids are how the IMPROVE phase reports each outcome.
  - Each item MUST be INDEPENDENTLY REVERTIBLE and touch a DISTINCT, LOW-CONFLICT area, so a
    failure in one does not poison the others. Do NOT split one logical change across items, and
    do NOT bundle several edits into one item.
  - Prefer at most ONE benchmark/performance-affecting item so its measured delta stays
    attributable; mark such an item clearly.
  - For each item give the IMPROVE phase enough to execute WITHOUT re-analysing: id, title, a
    rough \`risk\` (low/medium/high), target files, exact approach, and how to prove it worked.

Each item is applied and verified independently in the IMPROVE phase, so every kept change stays
attributable even though they ship together.

---

## 5. Emit the signal (MANDATORY — your LAST action)

Writing the report (§4) + this signal is your SINGLE NON-NEGOTIABLE terminal obligation. The MOMENT
you finish reading the in-scope source, write them IMMEDIATELY — before ANY optional or "nice to
have" step, and never run a verification command first. LAST RESORT: if your turn or context budget
is about to run out, STOP everything else and emit this signal NOW with the findings you already
have. A partial-but-valid \`improvements_found\` signal is always better than none — and you must
NEVER record a budget-truncated run as \`no_improvements\` (that would falsely converge the loop);
\`no_improvements\` is honest ONLY after the full fresh read of §1–§3.

Overwrite \`${stateDir}/signal.json\` with EXACTLY this shape (valid JSON, no comments):

\`\`\`json
${signalShapeAnalyze(stateDir)}
\`\`\`

- \`iteration\` MUST equal the number in \`current.json\`.
- \`result\` = \`"improvements_found"\` only when at least one concrete, worthwhile improvement
  exists; otherwise \`"no_improvements"\` with \`nextImprovement\` = \`""\` and \`plannedImprovements\`
  = \`[]\`.
- \`plannedImprovements\` lists EVERY item from your \`## BATCH PLAN\`, same ids and order (1..${config.improvementBatchSize}
  max); \`nextImprovement\` repeats item 1's title for backward compatibility.
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

## 4b. Commit this batch's KEPT changes (git — ENABLED)

Per-iteration git commits are ON. After the decision gate, ONLY if at least one item was KEPT
(\`keptCount >= 1\`):

- Make ONE commit for the whole iteration containing EVERY kept item's files, with a message
  PREFIXED by \`retry-now#<PADDED>: \` (PADDED from \`current.json\`) that summarises the kept items,
  e.g. \`retry-now#0012: batch — cache regex, dedupe path helper, drop dead export (3 kept)\`. This
  prefix lets the user identify which iteration each commit belongs to. Per-item attribution lives in
  the report and ledger, so a single larger commit per iteration is intended here.
- Commit ONLY files you modified for KEPT items. Do NOT commit files you reverted, and do NOT
  \`git add\` the \`${DIR}/\` directory (it is gitignored) or unrelated pre-existing working-tree
  changes.
- This loop runs UNATTENDED — no human is present to enter a commit-signing passphrase. If the commit
  fails or stalls because of commit signing (\`commit.gpgsign\`, GPG or SSH signing — e.g.
  \`gpg failed to sign the data\`, \`No secret key\`, or a pinentry/passphrase prompt), retry the
  SAME commit once with \`--no-gpg-sign\` (e.g. \`git commit --no-gpg-sign -m "retry-now#<PADDED>: …"\`)
  so signing can never block the iteration. Landing the change matters more than the signature here.
- If NOTHING was kept (\`keptCount = 0\`), do NOT commit.
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

The batch plan should contain at most ONE benchmark/performance-affecting item; measure around THAT
item alone so its delta stays attributable (apply it in its own checkpoint group when practical).
Benchmarks vary run-to-run with system load, so a single before/after pair is NOT trustworthy.
Run the command ${config.benchRuns} times BEFORE that item and take the MEDIAN (note the spread).
After it, run ${config.benchRuns} times again and take the median the same way. Speed is the TOP
priority, so compare MEDIANS: if the after-median is clearly WORSE than the before-median beyond the
run-to-run noise you observed, that is a REGRESSION and you MUST REVERT that item. If it is better or
within the noise band (statistically neutral), it is acceptable to keep. Report both medians, the
% delta and the observed noise in that item's metricDelta and the report.`
    : `This project has NO benchmark command configured — strongly suboptimal, because a performance
regression can then slip in unmeasured. For any benchmark/performance-affecting item in the batch
(keep it to at most one), capture the most meaningful OBJECTIVE baseline you can (wall-clock timing
of the hot path, output size, allocation count) and measure it the SAME way ${config.benchRuns}x
before and after that item; treat a clear regression as grounds to REVERT it. For pure cleanup
items (e.g. dead-code removal) with no measurable runtime effect, say so.`
  const hasVerify =
    config.verifyEnabled &&
    (config.verifyTest !== '' || config.verifyLint !== '')
  const verifyBlock = hasVerify
    ? `## 3b. Step 3 — verify in CHECKPOINT GROUPS (REQUIRED)

These EXACT commands are this iteration's completion check:
${config.verifyTest ? `- test: \`${config.verifyTest}\`\n` : ''}${config.verifyLint ? `- lint: \`${config.verifyLint}\`\n` : ''}
Do NOT run them after every single item (that throws away the whole point of batching one analysis)
and do NOT run them only once at the very end (a late failure then makes isolating the culprit
expensive). Instead CHECKPOINT after every 2 applied items, and once more after the final item:

1. Apply up to 2 items (per section 2), each backed up separately under \`item-<id>/\`.
2. Run the commands above ONCE for that group.
   - GREEN → those items are LOCKED IN as \`kept\`. Continue to the next group.
   - RED → restore ONLY this group's unverified items from their \`item-<id>/\` backups, in REVERSE
     order, then re-run the commands to confirm GREEN again. Mark each rolled-back item
     \`reverted\` (a working change you could not keep) or \`failed\` (could not be made to work).
     Items LOCKED IN by an earlier GREEN checkpoint stay \`kept\` — never undo them.
3. After the last group the working tree MUST be GREEN. Never leave it red.

KEEP an item only when the checkpoint group containing it passed every command above.`
    : `## 3b. Step 3 — verify in CHECKPOINT GROUPS (no automated test/lint configured)

This project has no test/lint command configured for the loop (the user accepted proceeding
without one). After every 2 items (and after the final item), re-read those items and the
directly-related code: keep an item only if it is correct and self-consistent, otherwise restore it
from its \`item-<id>/\` backup and mark it \`reverted\`/\`failed\`. Leave the working tree consistent.`
  return `# IMPROVE PHASE — retry-now

You are a FRESH session with NO memory of prior iterations. This phase runs only because the
ANALYZE phase of THIS iteration found an improvement. All state is on disk.

---

## 0. Load context (this iteration only)

1. \`${stateDir}/current.json\` — your \`iteration\` and zero-padded \`padded\` id.
2. \`${stateDir}/signal.json\` — the analyze result; \`plannedImprovements\` is your ordered work list.
3. \`${stateDir}/reports/<PADDED>-analyze.md\` — THIS iteration's analysis. Its
   \`## BATCH PLAN\` section is your exact spec for every item.
4. Project convention docs at the repo root (AGENTS.md / CLAUDE.md / README).

Do not browse older reports/ledger — everything you need is this iteration's analyze report.
Execute the batch plan: apply its items IN ORDER, each one INDEPENDENTLY backed up, verified and
kept-or-reverted, so every kept change stays attributable even though the batch ships together. A
batch may be a PARTIAL success — keeping the good items and rolling back only the bad ones is the
expected, correct outcome, not a failure. Never turn the batch into one big sweeping rewrite.

---

${scopeSection(scope, 'changes and measurement')}## 1. Measure BEFORE (baseline)

${benchBlock}

### Improvement priorities

${config.direction.trim()}

---

## 2. Back up, then implement — PER ITEM

Work the plan items in order. For EACH item \`<id>\`:

- Back up first: COPY every file that item will modify into \`${stateDir}/backups/<PADDED>/item-<id>/\`,
  preserving relative paths. These per-item backups are your ONLY revert source — the loop
  deliberately does NOT use git for revert, so it never disturbs unrelated working-tree changes.
- Implement EXACTLY that one item from the analyze spec. Smallest correct change. No suppressed
  warnings, no type-escape casts, no unjustified unsafe operations. Obey the project's convention
  docs.
- If a LATER item turns out to be already satisfied or invalidated by an EARLIER kept item, do
  NOT force it — mark it \`skipped\` and move on.

Verification is grouped (next section) so you do not pay a full test+lint run after every single
item; never collapse multiple items into one to dodge that.

---

## 3. Measure AFTER

For the benchmark/performance-affecting item, re-run the SAME measurement from step 1 and compare
against the baseline. Items with no measurable runtime effect need no measurement.

---

${verifyBlock}

---

## 4. Decision gate — applied PER ITEM, then rolled up for the batch

Per item, following the priority order in the improvement priorities above:
- The primary priority REGRESSED → REVERT that item from its \`item-<id>/\` backup → status \`reverted\`.
- Improved or statistically neutral AND its checkpoint group is green → KEEP → status \`kept\`.
- Could not complete safely (its group won't go green) → revert it → status \`failed\`.
- Invalidated/already-satisfied by an earlier kept item → status \`skipped\`.

A pure quality item with a neutral primary metric may be KEPT. Never keep anything that regresses
the top priority. Always leave the build GREEN and the working tree consistent.

Roll the per-item outcomes up into the batch \`result\`:
- \`"applied"\` — at least one item was \`kept\` (real progress this iteration, even if others were rolled back).
- \`"applied_reverted"\` — NOTHING was kept but at least one item was a working change you rolled back.
- \`"failed"\` — nothing was kept and nothing was even a viable change (could not reach green).
${gitBlock}
---

## 5. Append to the ledger (human-facing; NOT read by analyze)

Append ONE row PER batch item to \`${stateDir}/ledger.md\` (same \`<PADDED>\` on every row so the
iteration's items group together):

\`| <PADDED> | <item title> | kept / reverted / failed / skipped | <delta or -> | <files touched> |\`

---

## 6. Write the improvement report

Write \`${stateDir}/reports/<PADDED>-improve.md\`: the batch outcome (kept / reverted / failed /
skipped counts) and, for EVERY item, its id, title, files touched, before/after key numbers where
measured, and the decision + reason. Make each kept item independently reviewable.

---

## 7. Emit the signal (MANDATORY — LAST action)

Overwrite \`${stateDir}/signal.json\` with EXACTLY:

\`\`\`json
${signalShapeImprove(stateDir)}
\`\`\`

- \`result\` is one of \`"applied"\` | \`"applied_reverted"\` | \`"failed"\`, rolled up per section 4.
- \`appliedImprovements\` has ONE entry per plan item you acted on, each with its \`id\` (matching the
  analyze plan), \`title\`, and final \`status\` (\`kept\`/\`reverted\`/\`failed\`/\`skipped\`).
- \`keptCount\`/\`revertedCount\`/\`failedCount\`/\`skippedCount\` MUST match \`appliedImprovements\`.
- \`metricDelta\` is the benchmark item's measured delta, or a short batch note, or \`"none"\`.
- \`iteration\` MUST equal \`current.json\`.
`
}
