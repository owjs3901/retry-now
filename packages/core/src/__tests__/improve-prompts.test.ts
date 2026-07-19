import { expect, test } from 'bun:test'

import {
  buildItemImplementPrompt,
  buildItemReviewPrompt,
} from '../improve-prompts.ts'
import type { ImproveItemPaths } from '../paths.ts'
import { normalizeSignal } from '../signal.ts'
import type { PlannedImprovement, RetryNowConfig, Signal } from '../types.ts'

const ITEM: PlannedImprovement = {
  id: '7',
  title: 'Make item signals explicit',
  risk: 'low',
  targetFiles: ['packages/core/src/improve-prompts.ts'],
}

const ARTIFACTS: ImproveItemPaths = {
  key: '0042-01-implement-7',
  current: '.retry-now/items/0042-01-implement-7.current.json',
  signal: '.retry-now/items/0042-01-implement-7.signal.json',
  prompt: '.retry-now/items/0042-01-implement-7.prompt.md',
  report: '.retry-now/reports/0042-01-implement-7.md',
  log: '.retry-now/logs/0042-01-implement-7.log',
  backupDir: '.retry-now/backups/0042/item-01-7',
}

const CONFIG: RetryNowConfig = {
  version: 1,
  agent: 'opencode',
  analysisAgent: 'opencode',
  improveAgent: 'claude',
  reviewAgent: 'claude',
  model: '',
  analysisModel: '',
  improveModel: '',
  reviewModel: '',
  modelVariant: '',
  analysisVariant: '',
  improveVariant: '',
  reviewVariant: '',
  agentProfile: '',
  analysis: 'analyze',
  direction: 'make the smallest safe change',
  completion: 'verified',
  threshold: 3,
  revertThreshold: 3,
  maxIterations: 10,
  skipPermissions: true,
  commitPerIteration: false,
  verifyEnabled: true,
  verifyTest: 'bun test',
  verifyLint: 'bun run lint',
  benchCommand: '',
  benchRuns: 3,
  improvementBatchSize: 1,
  waitForQuota: false,
  quotaPollMs: 1_000,
  maxQuotaWaitMs: 10_000,
  targets: [],
  phaseTimeoutMs: 1_800_000,
}

function input() {
  return {
    config: CONFIG,
    iteration: 42,
    item: ITEM,
    artifacts: ARTIFACTS,
    scope: 'packages/core',
  }
}

function jsonBlock(prompt: string): unknown {
  const json = /```json\n([\s\S]*?)\n```/.exec(prompt)?.[1]
  if (json === undefined) throw new Error('prompt has no JSON signal block')
  return JSON.parse(json)
}

const IMPLEMENTATION: Signal = {
  iteration: 42,
  phase: 'improve',
  result: 'applied',
  report: ARTIFACTS.report,
  plannedCount: 1,
  keptCount: 1,
  revertedCount: 0,
  failedCount: 0,
  skippedCount: 0,
  appliedImprovements: [
    {
      id: ITEM.id,
      title: ITEM.title,
      status: 'kept',
      impact: 'The candidate uses the required signal contract.',
      decisionReason: 'The focused tests pass.',
      metricDelta: 'none',
      files: ['packages/core/src/improve-prompts.ts'],
    },
  ],
  summary: 'Implemented the item.',
  timestamp: '2026-07-18T00:00:00.000Z',
}

test('item implement prompt embeds the concrete single-item signal contract', () => {
  // Given / When
  const prompt = buildItemImplementPrompt(input())
  const signal = normalizeSignal(jsonBlock(prompt))

  // Then
  expect(prompt).toContain('```json')
  expect(prompt).toContain(ARTIFACTS.signal)
  expect(signal?.result).toBe('applied')
  expect(signal?.plannedCount).toBe(1)
  expect(signal?.appliedImprovements).toEqual([
    expect.objectContaining({ id: ITEM.id, title: ITEM.title, status: 'kept' }),
  ])
})

test('item review prompt defines every terminal result and item verdict', () => {
  // Given / When
  const prompt = buildItemReviewPrompt(input(), IMPLEMENTATION)

  // Then
  expect(prompt).toContain('```json')
  expect(prompt).toContain('"plannedCount": 1')
  for (const result of ['applied', 'applied_reverted', 'failed']) {
    expect(prompt).toContain(`"${result}"`)
  }
  for (const status of ['kept', 'reverted', 'failed', 'skipped']) {
    expect(prompt).toContain(`"${status}"`)
  }
})

test('embedded item signal examples pass the production signal normalizer', () => {
  // Given / When
  const examples = [
    jsonBlock(buildItemImplementPrompt(input())),
    jsonBlock(buildItemReviewPrompt(input(), IMPLEMENTATION)),
  ]

  // Then
  for (const example of examples) {
    const signal = normalizeSignal(example)
    expect(signal).not.toBeNull()
    expect(signal?.appliedImprovements).toHaveLength(1)
  }
})

test('item prompts render benchmark and direct-inspection verification branches', () => {
  // Given
  const withoutCommands = {
    ...input(),
    config: {
      ...CONFIG,
      verifyEnabled: false,
      verifyTest: '',
      verifyLint: '',
    },
    item: { id: '8', title: 'Inspect directly' },
    scope: '',
  }
  const withBenchmark = {
    ...input(),
    config: { ...CONFIG, benchCommand: 'bun run bench', benchRuns: 5 },
  }

  // When
  const implementPrompt = buildItemImplementPrompt(withoutCommands)
  const reviewPrompt = buildItemReviewPrompt(withBenchmark, IMPLEMENTATION)

  // Then
  expect(implementPrompt).toContain('- no configured command; inspect directly')
  expect(reviewPrompt).toContain('- benchmark: `bun run bench` (5 runs')
})
