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

export function buildItemImplementPrompt(input: ItemPromptInput): string {
  return `# IMPROVE ITEM IMPLEMENTATION

You are a FRESH top-level session. Process EXACTLY the one plan item below. Do not create or
delegate to sub-agents and do not inspect or process another batch item.

${common(input)}

Before editing, copy every existing file you will change into the backup directory while preserving
its repository-relative path, and record every new file so rejection can delete it. Implement the
smallest correct candidate and run the configured relevant verification/benchmark. Your conclusion
is only an UNTRUSTED RECOMMENDATION for an independent reviewer. Write exactly one
appliedImprovements entry, with phase "improve", plannedCount 1, all four status counts, evidence,
and changed files when recommending kept. Write the report, then overwrite only the signal path as
your final action. Never commit.`
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
verification/benchmark yourself. You alone own the final kept/reverted/failed/skipped verdict. If
you reject the candidate for any reason, restore its backup completely and delete candidate-created
files BEFORE signalling so the next item cannot observe rejected work. Write exactly one
appliedImprovements entry, with phase "improve", plannedCount 1, all four status counts, evidence,
and files only for a kept verdict. Write the report, then overwrite only the signal path as your
final action. Never commit.`
}
