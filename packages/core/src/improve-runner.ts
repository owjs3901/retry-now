import { writeCanonicalImproveBatch } from './improve-batch.ts'
import {
  buildItemImplementPrompt,
  buildItemReviewPrompt,
} from './improve-prompts.ts'
import { writeText } from './io.ts'
import {
  type ImproveItemPaths,
  type Paths,
  resolveImproveItemPaths,
} from './paths.ts'
import type {
  AgentRole,
  ImproveStage,
  PlannedImprovement,
  RetryNowConfig,
  Signal,
} from './types.ts'

export type ItemStageOutcome =
  | { readonly kind: 'ok'; readonly signal: Signal }
  | { readonly kind: 'quota' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'failed' }
  | {
      readonly kind: 'head-changed'
      readonly expectedHead: string
      readonly actualHead: string
    }

export type ItemStageRun = {
  readonly role: AgentRole
  readonly stage: ImproveStage
  readonly item: PlannedImprovement
  readonly itemIndex: number
  readonly artifacts: ImproveItemPaths
  readonly message: string
}

type ImproveBatchInput = {
  readonly paths: Paths
  readonly config: RetryNowConfig
  readonly iteration: number
  readonly planned: readonly PlannedImprovement[]
  readonly stateDirRel: string
  readonly scope: string
  readonly log: (line: string) => void
  readonly execute: (run: ItemStageRun) => Promise<ItemStageOutcome>
}

export type ImproveBatchOutcome =
  | { readonly kind: 'ok'; readonly signal: Signal }
  | { readonly kind: 'quota'; readonly stage: ImproveStage }
  | { readonly kind: 'aborted'; readonly stage: ImproveStage }
  | { readonly kind: 'failed'; readonly stage: ImproveStage }
  | {
      readonly kind: 'head-changed'
      readonly stage: ImproveStage
      readonly itemId: string
      readonly expectedHead: string
      readonly actualHead: string
    }

function message(input: ImproveBatchInput, run: ItemStageRun): string {
  const prompt = `${input.stateDirRel}/items/${run.artifacts.key}.prompt.md`
  const signal = `${input.stateDirRel}/items/${run.artifacts.key}.signal.json`
  return `retry-now item ${run.item.id} ${run.stage}. You are a FRESH top-level session with no continuation or resume context. Read and obey ${prompt}. Your final action must overwrite ${signal}.`
}

export async function runImproveBatch(
  input: ImproveBatchInput,
): Promise<ImproveBatchOutcome> {
  const reviews: Signal[] = []
  for (const [itemIndex, item] of input.planned.entries()) {
    const implementArtifacts = resolveImproveItemPaths(
      input.paths,
      input.iteration,
      itemIndex,
      'implement',
      item.id,
    )
    await writeText(
      implementArtifacts.prompt,
      buildItemImplementPrompt({
        config: input.config,
        iteration: input.iteration,
        item,
        artifacts: implementArtifacts,
        scope: input.scope,
      }),
    )
    const implementRun: ItemStageRun = {
      role: 'improve',
      stage: 'implement',
      item,
      itemIndex,
      artifacts: implementArtifacts,
      message: '',
    }
    input.log(`  ↳ item ${item.id} implement fresh session`)
    const implementation = await input.execute({
      ...implementRun,
      message: message(input, implementRun),
    })
    if (implementation.kind === 'head-changed') {
      return {
        ...implementation,
        stage: 'implement',
        itemId: item.id,
      }
    }
    if (implementation.kind !== 'ok') {
      return { kind: implementation.kind, stage: 'implement' }
    }
    const implementationEvidence: Signal = {
      ...implementation.signal,
      report: implementArtifacts.report,
    }

    const reviewArtifacts = resolveImproveItemPaths(
      input.paths,
      input.iteration,
      itemIndex,
      'review',
      item.id,
    )
    await writeText(
      reviewArtifacts.prompt,
      buildItemReviewPrompt(
        {
          config: input.config,
          iteration: input.iteration,
          item,
          artifacts: reviewArtifacts,
          scope: input.scope,
        },
        implementationEvidence,
      ),
    )
    const reviewRun: ItemStageRun = {
      role: 'review',
      stage: 'review',
      item,
      itemIndex,
      artifacts: reviewArtifacts,
      message: '',
    }
    input.log(`  ↳ item ${item.id} review fresh session`)
    const review = await input.execute({
      ...reviewRun,
      message: message(input, reviewRun),
    })
    if (review.kind === 'head-changed') {
      return { ...review, stage: 'review', itemId: item.id }
    }
    if (review.kind !== 'ok') return { kind: review.kind, stage: 'review' }
    reviews.push({ ...review.signal, report: reviewArtifacts.report })
  }
  return {
    kind: 'ok',
    signal: await writeCanonicalImproveBatch(
      input.paths,
      input.iteration,
      input.planned,
      reviews,
      `${input.stateDirRel}/reports/${String(input.iteration).padStart(4, '0')}-improve.md`,
    ),
  }
}
