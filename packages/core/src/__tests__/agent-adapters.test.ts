import { expect, test } from 'bun:test'

import {
  agentForRole,
  buildAgentCommand,
  modelForPhase,
  modelForRole,
  UnknownAgentError,
  variantForPhase,
  variantForRole,
} from '../agents.ts'
import type { RetryNowConfig } from '../types.ts'

function cfg(overrides: Partial<RetryNowConfig> = {}): RetryNowConfig {
  const agent = overrides.agent ?? 'opencode'
  return {
    version: 1,
    agent,
    analysisAgent: overrides.analysisAgent ?? agent,
    improveAgent: overrides.improveAgent ?? agent,
    reviewAgent: overrides.reviewAgent ?? overrides.improveAgent ?? agent,
    model: '',
    analysisModel: '',
    improveModel: '',
    reviewModel: '',
    modelVariant: '',
    analysisVariant: '',
    improveVariant: '',
    reviewVariant: '',
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
    phaseTimeoutMs: 1_800_000,
    ...overrides,
  }
}

test('role resolvers independently select analysis, implementation, and review settings', () => {
  const config = cfg({
    analysisAgent: 'claude',
    improveAgent: 'codex',
    reviewAgent: 'opencode',
    analysisModel: 'anthropic/analyzer',
    improveModel: 'openai/implementer',
    reviewModel: 'openai/reviewer',
    analysisVariant: 'max',
    improveVariant: 'xhigh',
    reviewVariant: 'high',
  })

  expect(agentForRole(config, 'analyze')).toBe('claude')
  expect(agentForRole(config, 'improve')).toBe('codex')
  expect(agentForRole(config, 'review')).toBe('opencode')
  expect(modelForRole(config, 'analyze')).toBe('anthropic/analyzer')
  expect(modelForRole(config, 'improve')).toBe('openai/implementer')
  expect(modelForRole(config, 'review')).toBe('openai/reviewer')
  expect(variantForRole(config, 'analyze')).toBe('max')
  expect(variantForRole(config, 'improve')).toBe('xhigh')
  expect(variantForRole(config, 'review')).toBe('high')
})

test('legacy phase resolvers preserve the analyze and improve settings', () => {
  const config = cfg({
    analysisModel: 'anthropic/analyzer',
    improveModel: 'openai/implementer',
    analysisVariant: 'max',
    improveVariant: 'xhigh',
  })

  expect(modelForPhase(config, 'analyze')).toBe('anthropic/analyzer')
  expect(modelForPhase(config, 'improve')).toBe('openai/implementer')
  expect(variantForPhase(config, 'analyze')).toBe('max')
  expect(variantForPhase(config, 'improve')).toBe('xhigh')
})

test('review command uses its own CLI agent, model, and variant', () => {
  const command = buildAgentCommand(
    cfg({
      agent: 'claude',
      improveAgent: 'codex',
      reviewAgent: 'opencode',
      improveModel: 'openai/implementer',
      reviewModel: 'openai/reviewer',
      improveVariant: 'xhigh',
      reviewVariant: 'high',
    }),
    'review changes',
    'review',
  )

  expect(command).toEqual({
    cmd: 'opencode',
    args: [
      'run',
      'review changes',
      '--dangerously-skip-permissions',
      '--model',
      'openai/reviewer',
      '--variant',
      'high',
    ],
  })
})

test('review variant is inferred from the review model when no variant is configured', () => {
  const config = cfg({ reviewModel: 'openai/reviewer' })

  expect(variantForRole(config, 'review')).toBe('xhigh')
})

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

/** The value opencode would receive for `--variant`, or undefined when the flag is absent. */
function variantOf(args: readonly string[]): string | undefined {
  const i = args.indexOf('--variant')
  return i >= 0 ? args[i + 1] : undefined
}

test('opencode defaults an unset variant to the model top tier (openai→xhigh, else→max)', () => {
  const analyze = buildAgentCommand(
    cfg({ analysisModel: 'anthropic/claude-opus-4-8' }),
    'analyze',
    'analyze',
  )
  const improve = buildAgentCommand(
    cfg({ improveModel: 'openai/gpt-5.6-sol' }),
    'improve',
    'improve',
  )

  expect(variantOf(analyze.args)).toBe('max')
  expect(variantOf(improve.args)).toBe('xhigh')
})

test('opencode gives analyze and improve their OWN top-tier variant from one config (the split)', () => {
  const config = cfg({
    analysisModel: 'anthropic/claude-opus-4-8',
    improveModel: 'openai/gpt-5.6-sol',
  })

  expect(variantOf(buildAgentCommand(config, 'analyze', 'analyze').args)).toBe(
    'max',
  )
  expect(variantOf(buildAgentCommand(config, 'improve', 'improve').args)).toBe(
    'xhigh',
  )
})

test('an explicit per-phase variant overrides both the shared variant and the auto top tier', () => {
  const analyze = buildAgentCommand(
    cfg({
      analysisModel: 'openai/gpt-5.6-sol', // auto would be xhigh
      modelVariant: 'medium', // shared is overridden too
      analysisVariant: 'high', // explicit per-phase wins
    }),
    'analyze',
    'analyze',
  )

  expect(variantOf(analyze.args)).toBe('high')
})

test('the shared modelVariant overrides the auto top tier when no per-phase variant is set', () => {
  const improve = buildAgentCommand(
    cfg({ improveModel: 'openai/gpt-5.6-sol', modelVariant: 'medium' }),
    'improve',
    'improve',
  )

  expect(variantOf(improve.args)).toBe('medium')
})

test('claude never receives --variant even though a top tier is always resolvable', () => {
  const claude = buildAgentCommand(
    cfg({ agent: 'claude', analysisModel: 'anthropic/claude-opus-4-8' }),
    'analyze',
    'analyze',
  )

  expect(claude.args).not.toContain('--variant')
})

test('claude translates the configured phase variant to effort', () => {
  const command = buildAgentCommand(
    cfg({
      agent: 'claude',
      analysisModel: 'anthropic/claude-opus-4-8',
      analysisVariant: 'high',
    }),
    'analyze',
    'analyze',
  )

  expect(command.args).toContain('--effort')
  expect(command.args).toContain('high')
})

test('codex translates the configured phase variant to model_reasoning_effort', () => {
  const command = buildAgentCommand(
    cfg({
      agent: 'codex',
      analysisModel: 'openai/gpt-5.6-sol',
      analysisVariant: 'high',
    }),
    'analyze',
    'analyze',
  )

  expect(command.args).toContain('--config')
  expect(command.args).toContain('model_reasoning_effort="high"')
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
      '--config',
      'model_reasoning_effort="xhigh"',
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
      '--config',
      'model_reasoning_effort="xhigh"',
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
      '--effort',
      'max',
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
    '--effort',
    'max',
  ])
})

test('unknown agent throws an explicit adapter error at the boundary', () => {
  const buildUnknownAgentCommand = () =>
    buildAgentCommand(cfg({ agent: 'unknown' as never }), 'analyze', 'analyze')

  expect(buildUnknownAgentCommand).toThrow(UnknownAgentError)
})
