/**
 * Field caps for the agent → driver signal, declared exactly once.
 *
 * These caps are POLICY, not structure. `normalizeSignal` decodes untrusted JSON into a well-typed
 * `Signal` and deliberately enforces NONE of them: a parser that deletes an over-cap field forces
 * the phase validator to report `must report <field>` for text the agent genuinely supplied, which
 * is a false reason a retry cannot act on. The phase validators (`validateAnalyzeSignal` /
 * `validateImproveSignal`) are the single enforcement point and always report the MEASURED length
 * beside the cap, so a fresh retry session learns the real reason.
 *
 * Every cap MUST also be visible to the agent that has to respect it. `signalLimitsTable()` renders
 * this object directly into the generated prompts, so a cap can never drift out of sync with what
 * the agent was told — changing a number here changes the prompt on the next scaffold.
 */
export const SIGNAL_LIMITS = {
  /** plan/outcome item title — also fed verbatim into the per-item implementation prompt */
  title: 200,
  /** ANALYZE plan free text: `approach` and `verification` */
  planText: 2000,
  /** IMPROVE per-item `impact` */
  impact: 1000,
  /** IMPROVE per-item `decisionReason` */
  decisionReason: 1000,
  /** IMPROVE per-item `metricDelta` */
  metricDelta: 500,
  /** any repository-relative file path carried in a signal */
  filePath: 500,
  /** `targetFiles` entries retained per plan item */
  targetFiles: 64,
  /**
   * Items one ANALYZE plan may contain. This is the ceiling the driver will actually execute: every
   * planned item costs a fresh implementation session plus a fresh independent review session, so an
   * unbounded plan is an unbounded spend on a loop designed to run unattended overnight. Must equal
   * `MAX_IMPROVEMENT_BATCH_SIZE`; `limits.test.ts` pins the two together.
   */
  planItems: 16,
} as const

type SignalLimitRow = {
  readonly field: string
  readonly cap: string
  readonly exceeded: string
}

/**
 * The rendered rows, derived from `SIGNAL_LIMITS` rather than restated, so the prompt table and the
 * enforced numbers cannot disagree.
 */
const SIGNAL_LIMIT_ROWS: readonly SignalLimitRow[] = [
  {
    field: 'title',
    cap: `${SIGNAL_LIMITS.title} characters`,
    exceeded: 'signal rejected, phase retried with the measured length',
  },
  {
    field: 'approach` / `verification',
    cap: `${SIGNAL_LIMITS.planText} characters`,
    exceeded: 'signal rejected, phase retried with the measured length',
  },
  {
    field: 'impact',
    cap: `${SIGNAL_LIMITS.impact} characters`,
    exceeded: 'signal rejected, phase retried with the measured length',
  },
  {
    field: 'decisionReason',
    cap: `${SIGNAL_LIMITS.decisionReason} characters`,
    exceeded: 'signal rejected, phase retried with the measured length',
  },
  {
    field: 'metricDelta',
    cap: `${SIGNAL_LIMITS.metricDelta} characters`,
    exceeded: 'signal rejected, phase retried with the measured length',
  },
  {
    field: 'files` / `targetFiles` entry',
    cap: `${SIGNAL_LIMITS.filePath} characters`,
    exceeded: 'path rejected as unsafe',
  },
  {
    field: 'targetFiles',
    cap: `${SIGNAL_LIMITS.targetFiles} entries`,
    exceeded: 'extra entries are not retained',
  },
  {
    field: 'plannedImprovements',
    cap: `${SIGNAL_LIMITS.planItems} items`,
    exceeded: 'signal rejected, phase retried with the measured count',
  },
]

/** Render the field caps as a markdown table for the generated prompts. */
export function signalLimitsTable(): string {
  return [
    '| signal field | cap | when exceeded |',
    '|---|---|---|',
    ...SIGNAL_LIMIT_ROWS.map(
      (row) => `| \`${row.field}\` | ${row.cap} | ${row.exceeded} |`,
    ),
  ].join('\n')
}

/**
 * The report/signal role separation. Without this the caps above read as a contradiction of the
 * surrounding instruction to justify every decision with detailed evidence, and a conscientious
 * agent writes a long `decisionReason` precisely because it was told to be thorough.
 */
export const SIGNAL_FIELD_DISCIPLINE = `The report markdown and the signal have DIFFERENT jobs, and the caps above apply only to the signal:

- The REPORT is where detailed evidence belongs. Command output, measurements, diffs, and the full
  reasoning chain go there, at whatever length the evidence needs. Nothing is capped.
- The SIGNAL is a permanent, machine-read record that ends up in Git history. Each text field takes a
  2-3 sentence SUMMARY that stands on its own, and cites the report for the full evidence.

Writing the full evidence into a signal field does not make the decision better justified; it
exceeds the cap and costs the item a retry. Summarize in the signal, prove it in the report. Never
put credentials, tokens, secrets, source excerpts, or private customer data in a signal field.`
