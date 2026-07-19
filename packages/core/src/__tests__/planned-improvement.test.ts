import { expect, test } from 'bun:test'

import { buildAnalyzePrompt } from '../prompts.ts'
import { normalizeSignal } from '../signal.ts'
import type { RetryNowConfig } from '../types.ts'

function config(): RetryNowConfig {
  return {
    version: 1,
    agent: 'opencode',
    analysisAgent: 'opencode',
    improveAgent: 'codex',
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
    direction: 'improve safely',
    completion: 'verified',
    threshold: 3,
    revertThreshold: 3,
    maxIterations: 3,
    skipPermissions: true,
    commitPerIteration: false,
    verifyEnabled: false,
    verifyTest: '',
    verifyLint: '',
    benchCommand: '',
    benchRuns: 3,
    improvementBatchSize: 2,
    waitForQuota: false,
    quotaPollMs: 1_000,
    maxQuotaWaitMs: 10_000,
    targets: [],
    phaseTimeoutMs: 1_800_000,
  }
}

test('analyze signal schema requires executable details for every plan item', () => {
  const prompt = buildAnalyzePrompt(config())

  expect(prompt).toContain('"targetFiles"')
  expect(prompt).toContain('"approach"')
  expect(prompt).toContain('"verification"')
})

test('signal normalization preserves authoritative plan execution details', () => {
  const signal = normalizeSignal({
    iteration: 1,
    phase: 'analyze',
    result: 'improvements_found',
    report: '.retry-now/reports/0001-analyze.md',
    plannedImprovements: [
      {
        id: '1',
        title: 'remove duplicate lookup',
        risk: 'low',
        targetFiles: ['src/cache.ts', 'src/index.ts'],
        approach: 'Reuse the cache result instead of querying twice.',
        verification: 'Run the cache unit test and compare query counts.',
      },
    ],
    summary: 'one item',
    timestamp: '2026-07-14T00:00:00.000Z',
  })

  const item = signal?.plannedImprovements?.[0]
  expect(item?.id).toBe('1')
  expect(item && 'targetFiles' in item ? item.targetFiles : undefined).toEqual([
    'src/cache.ts',
    'src/index.ts',
  ])
  expect(item && 'approach' in item ? item.approach : undefined).toBe(
    'Reuse the cache result instead of querying twice.',
  )
  expect(item && 'verification' in item ? item.verification : undefined).toBe(
    'Run the cache unit test and compare query counts.',
  )
})
