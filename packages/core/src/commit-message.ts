import { oneLine } from './safe-text.ts'
import { commitPrefix } from './theme.ts'
import type { Signal } from './types.ts'

/** Build the driver-owned, evidence-rich commit message for one completed iteration. */
export function formatIterationCommitMessage(
  padded: string,
  signal: Signal,
): string {
  const items = signal.appliedImprovements ?? []
  const keptItems = items.filter((item) => item.status === 'kept')
  const rejectedItems = items.filter((item) => item.status !== 'kept')
  const kept =
    items.length > 0
      ? keptItems.length
      : Math.max(
          0,
          Math.trunc(signal.keptCount ?? (signal.result === 'applied' ? 1 : 0)),
        )
  const planned = Math.max(
    items.length,
    kept,
    Math.trunc(signal.plannedCount ?? items.length),
  )
  const subjectSummary =
    keptItems.length > 0
      ? oneLine(
          keptItems.map((item) => oneLine(item.title, 100)).join(', '),
          180,
        )
      : oneLine(signal.summary || 'kept improvements', 180)
  const lines = [
    `${commitPrefix(padded)}batch — ${subjectSummary} (${kept}/${planned} applied)`,
  ]

  if (items.length === 0) {
    lines.push(
      '',
      'Details unavailable: the agent emitted a legacy summary-only signal.',
    )
    return lines.join('\n')
  }

  lines.push('', `Applied (${kept}/${planned}):`)
  for (const item of keptItems) {
    const id = /^\d{1,4}$/.test(item.id) ? item.id : '?'
    const details = [
      `impact: ${oneLine(item.impact ?? 'not reported', 240)}`,
      ...(item.metricDelta
        ? [`evidence: ${oneLine(item.metricDelta, 120)}`]
        : []),
      `decision: ${oneLine(item.decisionReason ?? item.summary ?? 'not reported', 240)}`,
    ]
    lines.push(`- [${id}] ${oneLine(item.title, 100)} — ${details.join('; ')}`)
  }

  lines.push('', `Not applied (${rejectedItems.length}/${planned}):`)
  for (const item of rejectedItems) {
    const id = /^\d{1,4}$/.test(item.id) ? item.id : '?'
    const details = [
      item.status,
      `attempted impact: ${oneLine(item.impact ?? 'not reported', 240)}`,
      ...(item.metricDelta
        ? [`evidence: ${oneLine(item.metricDelta, 120)}`]
        : []),
      `reason: ${oneLine(item.decisionReason ?? item.summary ?? 'not reported', 240)}`,
    ]
    lines.push(`- [${id}] ${oneLine(item.title, 100)} — ${details.join('; ')}`)
  }

  return lines.join('\n')
}
