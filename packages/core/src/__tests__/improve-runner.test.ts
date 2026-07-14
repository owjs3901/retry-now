import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'

import {
  aggregateReviewSignals,
  validateReviewedTree,
} from '../improve-batch.ts'
import { type ItemStageRun, runImproveBatch } from '../improve-runner.ts'
import { readText, writeText } from '../io.ts'
import { resolvePaths } from '../paths.ts'
import type { RetryNowConfig, Signal } from '../types.ts'

function config(): RetryNowConfig {
  return {
    version: 1,
    agent: 'opencode',
    analysisAgent: 'opencode',
    improveAgent: 'codex',
    reviewAgent: 'claude',
    model: '',
    analysisModel: '',
    improveModel: 'openai/implementer',
    reviewModel: 'anthropic/reviewer',
    modelVariant: '',
    analysisVariant: '',
    improveVariant: 'xhigh',
    reviewVariant: 'max',
    agentProfile: '',
    analysis: 'analyze',
    direction: 'smallest safe change',
    completion: 'complete',
    threshold: 3,
    revertThreshold: 3,
    maxIterations: 3,
    skipPermissions: true,
    commitPerIteration: false,
    verifyEnabled: true,
    verifyTest: 'bun test',
    verifyLint: '',
    benchCommand: 'bun bench',
    benchRuns: 3,
    improvementBatchSize: 2,
    waitForQuota: false,
    quotaPollMs: 1_000,
    maxQuotaWaitMs: 10_000,
    targets: [],
  }
}

function itemSignal(run: ItemStageRun, status: 'kept' | 'reverted'): Signal {
  return {
    iteration: 1,
    phase: 'improve',
    result: status === 'kept' ? 'applied' : 'applied_reverted',
    report: run.artifacts.report,
    plannedCount: 1,
    appliedImprovements: [
      {
        id: run.item.id,
        title: run.item.title,
        status,
        impact: `${run.stage} impact`,
        decisionReason: `${run.stage} evidence`,
        ...(status === 'kept' ? { files: [`src/${run.item.id}.ts`] } : {}),
      },
    ],
    keptCount: status === 'kept' ? 1 : 0,
    revertedCount: status === 'reverted' ? 1 : 0,
    failedCount: 0,
    skippedCount: 0,
    summary: `${run.stage} summary`,
    timestamp: '2026-07-14T00:00:00.000Z',
  }
}

test('runner uses fresh implement-review order and only review verdicts become canonical', async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), 'retry-now-improve-runner-'))
  const paths = resolvePaths(root)
  const calls: ItemStageRun[] = []
  const planned = [
    { id: '1', title: 'first item', risk: 'low' as const },
    { id: '2', title: 'second item', risk: 'medium' as const },
  ]

  try {
    // When
    const outcome = await runImproveBatch({
      paths,
      config: config(),
      iteration: 1,
      planned,
      stateDirRel: '.retry-now',
      scope: '',
      log: () => undefined,
      execute: async (run) => {
        calls.push(run)
        const status =
          run.stage === 'implement' || run.item.id === '2' ? 'kept' : 'reverted'
        const signal = itemSignal(run, status)
        await writeText(
          run.artifacts.report,
          `${run.stage} report for ${run.item.id}`,
        )
        return { kind: 'ok', signal }
      },
    })

    // Then
    expect(
      calls.map((run) => `${run.item.id}:${run.stage}:${run.role}`),
    ).toEqual([
      '1:implement:improve',
      '1:review:review',
      '2:implement:improve',
      '2:review:review',
    ])
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(
      outcome.signal.appliedImprovements?.map((item) => item.status),
    ).toEqual(['reverted', 'kept'])
    expect(outcome.signal.keptCount).toBe(1)
    expect(outcome.signal.revertedCount).toBe(1)
    expect(await readText(join(paths.reportsDir, '0001-improve.md'))).toContain(
      'review report for 1',
    )
    expect(outcome.signal.report).toBe('.retry-now/reports/0001-improve.md')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('item prompts are isolated and reviewer is instructed to distrust and restore', async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), 'retry-now-improve-runner-'))
  const paths = resolvePaths(root)
  const prompts: string[] = []
  const artifactKeys: string[] = []
  const planned = [
    {
      id: '1',
      title: 'FIRST_ONLY',
      targetFiles: ['src/first.ts'],
      approach: 'FIRST_APPROACH',
      verification: 'FIRST_PROOF',
    },
    { id: '2', title: 'SECOND_ONLY' },
  ]

  try {
    // When
    await runImproveBatch({
      paths,
      config: config(),
      iteration: 1,
      planned,
      stateDirRel: '.retry-now',
      scope: '',
      log: () => undefined,
      execute: async (run) => {
        artifactKeys.push(run.artifacts.key)
        prompts.push((await readText(run.artifacts.prompt)) ?? '')
        const signal = itemSignal(run, 'kept')
        await writeText(run.artifacts.report, 'reviewed')
        return { kind: 'ok', signal }
      },
    })

    // Then
    expect(prompts[0]).toContain('FIRST_ONLY')
    expect(prompts[0]).toContain('src/first.ts')
    expect(prompts[0]).toContain('FIRST_APPROACH')
    expect(prompts[0]).toContain('FIRST_PROOF')
    expect(prompts[0]).not.toContain('SECOND_ONLY')
    expect(prompts[1]).toContain('UNTRUSTED EVIDENCE')
    expect(prompts[1]).toContain('src/first.ts')
    expect(prompts[1]).toContain('FIRST_APPROACH')
    expect(prompts[1]).toContain('FIRST_PROOF')
    expect(prompts[1]).toContain(
      'restore its backup completely and delete candidate-created',
    )
    expect(prompts[2]).toContain('SECOND_ONLY')
    expect(prompts[2]).not.toContain('FIRST_ONLY')
    expect(new Set(artifactKeys).size).toBe(4)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejected review must restore its candidate before the next item', () => {
  // Given
  const review: Signal = {
    iteration: 1,
    phase: 'improve',
    result: 'applied_reverted',
    report: 'report.md',
    plannedCount: 1,
    appliedImprovements: [
      {
        id: '1',
        title: 'first',
        status: 'reverted',
        impact: 'attempted change',
        decisionReason: 'review rejected it',
      },
    ],
    keptCount: 0,
    revertedCount: 1,
    failedCount: 0,
    skippedCount: 0,
    summary: 'rejected',
    timestamp: '2026-07-14T00:00:00.000Z',
  }

  // When / Then
  expect(
    validateReviewedTree(review, ['src/prior.ts'], ['src/prior.ts']),
  ).toBeNull()
  expect(
    validateReviewedTree(
      review,
      ['src/prior.ts'],
      ['src/prior.ts', 'src/1.ts'],
    ),
  ).toContain('unreported changed file')
})

test('reverted-only reviews produce an applied-reverted canonical result', () => {
  // Given
  const review: Signal = {
    iteration: 1,
    phase: 'improve',
    result: 'applied_reverted',
    report: 'review.md',
    plannedCount: 1,
    appliedImprovements: [
      {
        id: '1',
        title: 'item',
        status: 'reverted',
        impact: 'attempted change',
        decisionReason: 'independent review rejected it',
      },
    ],
    keptCount: 0,
    revertedCount: 1,
    failedCount: 0,
    skippedCount: 0,
    summary: 'reverted',
    timestamp: '2026-07-14T00:00:00.000Z',
  }

  // When
  const result = aggregateReviewSignals(
    1,
    [{ id: '1', title: 'item' }],
    [review],
    'batch.md',
  )

  // Then
  expect(result.result).toBe('applied_reverted')
  expect(result.revertedCount).toBe(1)
  expect(result.keptCount).toBe(0)
})

test('implement quota stops the batch after writing an unconfigured verification prompt', async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), 'retry-now-improve-runner-'))
  const paths = resolvePaths(root)
  const calls: ItemStageRun[] = []
  let prompt = ''

  try {
    // When
    const outcome = await runImproveBatch({
      paths,
      config: {
        ...config(),
        verifyEnabled: false,
        verifyTest: '',
        verifyLint: '',
        benchCommand: '',
      },
      iteration: 1,
      planned: [{ id: '1', title: 'item' }],
      stateDirRel: '.retry-now',
      scope: '',
      log: () => undefined,
      execute: async (run) => {
        calls.push(run)
        prompt = (await readText(run.artifacts.prompt)) ?? ''
        return { kind: 'quota' }
      },
    })

    // Then
    expect(outcome).toEqual({ kind: 'quota', stage: 'implement' })
    expect(calls.map((run) => `${run.item.id}:${run.stage}`)).toEqual([
      '1:implement',
    ])
    expect(prompt).toContain('- no configured command; inspect directly')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runner preserves unauthorized HEAD details and the affected item', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-improve-runner-'))
  const paths = resolvePaths(root)
  try {
    const outcome = await runImproveBatch({
      paths,
      config: config(),
      iteration: 1,
      planned: [{ id: 'unsafe', title: 'unsafe item' }],
      stateDirRel: '.retry-now',
      scope: '',
      log: () => undefined,
      execute: () =>
        Promise.resolve({
          kind: 'head-changed',
          expectedHead: 'expected',
          actualHead: 'actual',
        }),
    })

    expect(outcome).toEqual({
      kind: 'head-changed',
      stage: 'implement',
      itemId: 'unsafe',
      expectedHead: 'expected',
      actualHead: 'actual',
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runner preserves unauthorized HEAD details from review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-improve-runner-'))
  const paths = resolvePaths(root)
  try {
    const outcome = await runImproveBatch({
      paths,
      config: config(),
      iteration: 1,
      planned: [{ id: 'unsafe-review', title: 'unsafe review' }],
      stateDirRel: '.retry-now',
      scope: '',
      log: () => undefined,
      execute: (run) =>
        Promise.resolve(
          run.stage === 'implement'
            ? { kind: 'ok', signal: itemSignal(run, 'kept') }
            : {
                kind: 'head-changed',
                expectedHead: 'expected',
                actualHead: 'actual',
              },
        ),
    })

    expect(outcome).toEqual({
      kind: 'head-changed',
      stage: 'review',
      itemId: 'unsafe-review',
      expectedHead: 'expected',
      actualHead: 'actual',
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
