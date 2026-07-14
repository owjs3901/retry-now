import { expect, test } from 'bun:test'

import { buildAgentCommand, modelForRole, variantForRole } from '../agents.ts'
import { normalizeConfig } from '../config.ts'

test('blank review settings use the selected review CLI defaults across agents', () => {
  const config = normalizeConfig({
    agent: 'opencode',
    improveAgent: 'codex',
    reviewAgent: 'claude',
    improveModel: 'openai/gpt-5.6-sol',
    improveVariant: 'xhigh',
    reviewModel: '',
    reviewVariant: '',
    analysis: 'analyze',
    direction: 'improve safely',
    completion: 'verified',
  })

  expect(config.reviewModel).toBe('')
  expect(config.reviewVariant).toBe('')
  expect(modelForRole(config, 'review')).toBe('')
  expect(variantForRole(config, 'review')).toBe('max')
  expect(buildAgentCommand(config, 'review', 'review')).toEqual({
    cmd: 'claude',
    args: [
      '-p',
      'review',
      '--bare',
      '--output-format',
      'text',
      '--no-session-persistence',
      '--effort',
      'max',
      '--dangerously-skip-permissions',
    ],
  })
})

test('blank review settings preserve legacy fallback when review uses the implementation CLI', () => {
  const config = normalizeConfig({
    agent: 'opencode',
    improveAgent: 'codex',
    improveModel: 'openai/gpt-5.6-sol',
    improveVariant: 'xhigh',
    analysis: 'analyze',
    direction: 'improve safely',
    completion: 'verified',
  })

  expect(config.reviewAgent).toBe('codex')
  expect(modelForRole(config, 'review')).toBe('openai/gpt-5.6-sol')
  expect(variantForRole(config, 'review')).toBe('xhigh')
})
