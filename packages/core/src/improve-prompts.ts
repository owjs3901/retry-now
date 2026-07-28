import { SIGNAL_FIELD_DISCIPLINE, signalLimitsTable } from './limits.ts'
import type { ImproveItemPaths } from './paths.ts'
import type { PlannedImprovement, RetryNowConfig, Signal } from './types.ts'

type ItemPromptInput = {
  readonly config: RetryNowConfig
  readonly iteration: number
  readonly item: PlannedImprovement
  readonly artifacts: ImproveItemPaths
  readonly scope: string
}

function verification(config: RetryNowConfig): string {
  const commands = [
    config.verifyEnabled && config.verifyTest !== ''
      ? `- test: \`${config.verifyTest}\``
      : '',
    config.verifyEnabled && config.verifyLint !== ''
      ? `- lint: \`${config.verifyLint}\``
      : '',
    config.benchCommand !== ''
      ? `- benchmark: \`${config.benchCommand}\` (${config.benchRuns} runs; compare medians)`
      : '',
  ].filter((line) => line !== '')
  return commands.length > 0
    ? commands.join('\n')
    : '- no configured command; inspect directly'
}

function common(input: ItemPromptInput): string {
  return `Iteration: ${input.iteration}
Single authoritative plan item: ${JSON.stringify(input.item)}
Scope: ${input.scope || '(whole repository)'}
Direction: ${input.config.direction.trim()}
Backup directory: ${input.artifacts.backupDir}
Report path: ${input.artifacts.report}
Signal path: ${input.artifacts.signal}
Verification:
${verification(input.config)}`
}

function signalShapeItem(input: ItemPromptInput): string {
  return `\`\`\`json
${JSON.stringify(
  {
    iteration: input.iteration,
    phase: 'improve',
    result: 'applied',
    report: input.artifacts.report,
    plannedCount: 1,
    keptCount: 1,
    revertedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    appliedImprovements: [
      {
        id: input.item.id,
        title: input.item.title,
        status: 'kept',
        impact: 'what improved and why it matters',
        decisionReason: 'independent evidence for this verdict',
        metricDelta: 'none',
        files: [
          input.item.targetFiles?.[0] ?? '<changed repository-relative path>',
        ],
      },
    ],
    summary: '1-2 sentence summary',
    timestamp: '<ISO-8601>',
  },
  null,
  2,
)}
\`\`\``
}

/**
 * The field caps, stated in the prompt the agent actually obeys.
 *
 * These are enforced by the driver's validator, which rejects an over-cap signal outright rather
 * than trimming it — an item's evidence is never silently edited. An agent that is told to justify
 * every verdict with evidence, but not told the cap, writes a long `decisionReason` precisely
 * BECAUSE it is being thorough, so the cap and the role separation must travel together.
 */
function signalLimits(): string {
  return `Every text field above has a hard cap. Going over does NOT get truncated for you — the
signal is REJECTED and this item is retried in a fresh session, spending one of its few attempts:

${signalLimitsTable()}

${SIGNAL_FIELD_DISCIPLINE}`
}

export function buildItemImplementPrompt(input: ItemPromptInput): string {
  return `# IMPROVE ITEM IMPLEMENTATION

You are a FRESH top-level session. Process EXACTLY the one plan item below. Do not create or
delegate to sub-agents and do not inspect or process another batch item.

${common(input)}

Before editing, copy every existing file you will change into the backup directory while preserving
its repository-relative path, and record every new file so rejection can delete it. Implement the
smallest correct candidate and run the configured relevant verification/benchmark. Your conclusion
is only an UNTRUSTED RECOMMENDATION for an independent reviewer. After review, the driver independently
re-runs configured test/lint verification. A red result overrides any kept recommendation to reverted
and restores the last approved state, so claiming kept cannot bypass verification.

Write the signal using this exact single-item JSON shape:
${signalShapeItem(input)}

${signalLimits()}

Always emit exactly one appliedImprovements entry, plannedCount 1, and all four status counts. When
you made the change and recommend keeping it, use result "applied", status "kept", keptCount 1, and
list every changed file. If you could not implement it, use result "failed", status "failed",
failedCount 1, files [], and set the other three status counts to 0. These are terminal signals;
never emit result "pending". Write the report, then overwrite only the signal path as your final
action. Never commit.`
}

export function buildItemReviewPrompt(
  input: ItemPromptInput,
  implementation: Signal,
): string {
  return `# IMPROVE ITEM INDEPENDENT REVIEW

You are an INDEPENDENT FRESH top-level review session. Review EXACTLY the one plan item below. Do
not create or delegate to sub-agents and do not inspect or process another batch item.

${common(input)}

The implementer's signal below is UNTRUSTED EVIDENCE, never a decision:
${JSON.stringify(implementation, null, 2)}

Inspect the actual candidate diff and implementation report. Rerun every configured relevant
verification/benchmark yourself. Your verdict supersedes the implementer's recommendation entirely;
the driver then re-runs the configured test/lint itself as a final gate and overrides a kept verdict
to reverted when the tree is red, so a kept verdict you did not actually verify cannot survive. If
you reject the candidate for any reason, restore its backup completely and delete candidate-created
files BEFORE signalling so the next item cannot observe rejected work.

Write the signal using this exact single-item JSON shape:
${signalShapeItem(input)}

${signalLimits()}

Always emit exactly one appliedImprovements entry, plannedCount 1, and all four status counts. Use
result "applied" with status "kept", keptCount 1, and every kept file when you independently verify
and keep the candidate. Use result "applied_reverted" with status "reverted", revertedCount 1, and
files [] when you restore the backup. Use result "failed" with status "failed" and failedCount 1 on
failure. If the item is not applicable, use result "failed" with status "skipped", skippedCount 1,
and files []. In every case set the other three status counts to 0. These are terminal signals;
never emit result "pending". Write the report, then overwrite only the signal path as your final
action. Never commit.`
}
