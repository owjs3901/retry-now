import { join } from 'node:path'

import { validateCommitFileAttribution } from './git.ts'
import { readText, writeJson, writeText } from './io.ts'
import type { Paths } from './paths.ts'
import { pad } from './paths.ts'
import type { AppliedImprovement, PlannedImprovement, Signal } from './types.ts'

export function validateReviewedTree(
  review: Signal,
  approvedBaseline: readonly string[],
  current: readonly string[],
  scope = '',
): string | null {
  const outcome = review.appliedImprovements?.[0]
  const files = outcome?.status === 'kept' ? (outcome.files ?? []) : []
  return validateCommitFileAttribution(files, approvedBaseline, current, scope)
}

export function aggregateReviewSignals(
  iteration: number,
  planned: readonly PlannedImprovement[],
  reviews: readonly Signal[],
  report: string,
): Signal {
  const outcomes: AppliedImprovement[] = reviews.flatMap((signal) =>
    signal.appliedImprovements ? [...signal.appliedImprovements] : [],
  )
  const keptCount = outcomes.filter((item) => item.status === 'kept').length
  const revertedCount = outcomes.filter(
    (item) => item.status === 'reverted',
  ).length
  const failedCount = outcomes.filter((item) => item.status === 'failed').length
  const skippedCount = outcomes.filter(
    (item) => item.status === 'skipped',
  ).length
  const result =
    keptCount > 0
      ? 'applied'
      : revertedCount > 0
        ? 'applied_reverted'
        : 'failed'
  const deltas = outcomes
    .map((item) => item.metricDelta?.trim() ?? '')
    .filter((delta) => delta !== '')
  return {
    iteration,
    phase: 'improve',
    result,
    report,
    plannedCount: planned.length,
    appliedImprovements: outcomes,
    keptCount,
    revertedCount,
    failedCount,
    skippedCount,
    metricDelta: deltas.length > 0 ? deltas.join('; ') : 'none',
    summary: `Reviewed ${planned.length} item(s): ${keptCount} kept, ${revertedCount} reverted, ${failedCount} failed, ${skippedCount} skipped.`,
    timestamp: new Date().toISOString(),
  }
}

export async function writeCanonicalImproveBatch(
  paths: Paths,
  iteration: number,
  planned: readonly PlannedImprovement[],
  reviews: readonly Signal[],
  report: string,
): Promise<Signal> {
  const reportPath = join(paths.reportsDir, `${pad(iteration)}-improve.md`)
  const signal = aggregateReviewSignals(iteration, planned, reviews, report)
  const sections = await Promise.all(
    reviews.map(async (review, index) => {
      const item = signal.appliedImprovements?.[index]
      const content =
        (await readText(review.report)) ?? '(review report unavailable)'
      return `## Item ${item?.id ?? index + 1}: ${item?.title ?? 'unknown'}\n\nFinal status: **${item?.status ?? 'failed'}**\n\n${content}`
    }),
  )
  await writeText(
    reportPath,
    `# IMPROVE batch ${pad(iteration)}\n\n${signal.summary}\n\n${sections.join('\n\n')}`,
  )
  await writeJson(paths.signal, signal)
  return signal
}
