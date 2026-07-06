import { expect, test } from 'bun:test'

import { buildAgentCommand, UnknownAgentError } from '../agents.ts'
import type { RetryNowConfig } from '../types.ts'

function cfg(overrides: Partial<RetryNowConfig> = {}): RetryNowConfig {
  return {
    version: 1,
    agent: 'opencode',
    model: '',
    analysisModel: '',
    improveModel: '',
    modelVariant: '',
    agentProfile: '',
    analysis: 'analyse it',
    direction: 'improve it',
    completion: 'done when clean',
    threshold: 5,
    revertThreshold: 3,
    maxIterations: 50,
    skipPermissions: true,
    commitPerIteration: true,
    verifyEnabled: false,
    verifyTest: '',
    verifyLint: '',
    benchCommand: '',
    benchRuns: 5,
    improvementBatchSize: 8,
    waitForQuota: false,
    quotaPollMs: 900000,
    maxQuotaWaitMs: 21600000,
    targets: [],
    ...overrides,
  }
}

test('opencode command passes highest model variant separately from model and agent profile', () => {
  const command = buildAgentCommand(
    cfg({
      model: 'openai/gpt-5.5',
      modelVariant: 'xhigh',
      agentProfile: 'build',
    }),
    'improve',
    'improve',
  )

  expect(command).toEqual({
    cmd: 'opencode',
    args: [
      'run',
      'improve',
      '--dangerously-skip-permissions',
      '--model',
      'openai/gpt-5.5',
      '--variant',
      'xhigh',
      '--agent',
      'build',
    ],
  })
})

test('command uses phase-specific model over shared legacy model', () => {
  const analyze = buildAgentCommand(
    cfg({ model: 'openai/shared', analysisModel: 'openai/analyzer' }),
    'analyze',
    'analyze',
  )
  const improve = buildAgentCommand(
    cfg({ model: 'openai/shared', improveModel: 'openai/implementer' }),
    'improve',
    'improve',
  )

  expect(analyze.args).toContain('openai/analyzer')
  expect(analyze.args).not.toContain('openai/shared')
  expect(improve.args).toContain('openai/implementer')
  expect(improve.args).not.toContain('openai/shared')
})

test('codex command covers unattended and sandboxed modes', () => {
  const unattended = buildAgentCommand(
    cfg({ agent: 'codex', improveModel: 'openai/implementer' }),
    'improve',
    'improve',
  )
  const sandboxed = buildAgentCommand(
    cfg({ agent: 'codex', skipPermissions: false }),
    'analyze',
    'analyze',
  )

  expect(unattended).toEqual({
    cmd: 'codex',
    args: [
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      '--model',
      'openai/implementer',
      'improve',
    ],
  })
  expect(sandboxed).toEqual({
    cmd: 'codex',
    args: [
      'exec',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      'analyze',
    ],
  })
})

test('claude command uses bare fresh session flags and optional model/permissions', () => {
  const command = buildAgentCommand(
    cfg({ agent: 'claude', analysisModel: 'claude/analyzer' }),
    'analyze',
    'analyze',
  )
  const withoutBypass = buildAgentCommand(
    cfg({ agent: 'claude', skipPermissions: false }),
    'improve',
    'improve',
  )

  expect(command).toEqual({
    cmd: 'claude',
    args: [
      '-p',
      'analyze',
      '--bare',
      '--output-format',
      'text',
      '--no-session-persistence',
      '--model',
      'claude/analyzer',
      '--dangerously-skip-permissions',
    ],
  })
  expect(withoutBypass.args).toEqual([
    '-p',
    'improve',
    '--bare',
    '--output-format',
    'text',
    '--no-session-persistence',
  ])
})

test('unknown agent throws an explicit adapter error at the boundary', () => {
  expect(() =>
    buildAgentCommand(cfg({ agent: 'unknown' as never }), 'analyze', 'analyze'),
  ).toThrow(UnknownAgentError)
})
