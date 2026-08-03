import { expect, test } from 'bun:test'

import {
  type AgentSettingsPrompts,
  askRoleAgentSettings,
} from '../agent-settings.ts'

const CANCEL = Symbol('cancel')

function prompts(cancelAt?: number): AgentSettingsPrompts {
  let calls = 0
  let agentIndex = 0
  let textIndex = 0
  const agents = ['opencode', 'codex', 'claude'] as const
  const texts = [
    'analysis/model',
    'max',
    'improve/model',
    'xhigh',
    'review/model',
    'high',
  ] as const
  return {
    select: async () => {
      calls++
      if (calls === cancelAt) return CANCEL
      const value = agents[agentIndex]
      agentIndex++
      return value ?? 'opencode'
    },
    text: async () => {
      calls++
      if (calls === cancelAt) return CANCEL
      const value = texts[textIndex]
      textIndex++
      return value ?? ''
    },
    isCancel: (value): value is symbol => typeof value === 'symbol',
  }
}

test('returns all independently selected role settings', async () => {
  const settings = await askRoleAgentSettings(prompts())

  expect(settings).toEqual({
    analysisAgent: 'opencode',
    analysisModel: 'analysis/model',
    analysisVariant: 'max',
    improveAgent: 'codex',
    improveModel: 'improve/model',
    improveVariant: 'xhigh',
    reviewAgent: 'claude',
    reviewModel: 'review/model',
    reviewVariant: 'high',
  })
})

for (let promptNumber = 1; promptNumber <= 9; promptNumber++) {
  test(`returns null when prompt ${promptNumber} is cancelled`, async () => {
    expect(await askRoleAgentSettings(prompts(promptNumber))).toBeNull()
  })
}
