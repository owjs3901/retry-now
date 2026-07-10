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
    analysisVariant: '',
    improveVariant: '',
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

test('non-opencode agents never receive --variant even though a top tier is always resolvable', () => {
  const codex = buildAgentCommand(
    cfg({ agent: 'codex', improveModel: 'openai/gpt-5.6-sol' }),
    'improve',
    'improve',
  )
  const claude = buildAgentCommand(
    cfg({ agent: 'claude', analysisModel: 'anthropic/claude-opus-4-8' }),
    'analyze',
    'analyze',
  )

  expect(codex.args).not.toContain('--variant')
  expect(claude.args).not.toContain('--variant')
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
