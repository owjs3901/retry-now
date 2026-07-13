/**
 * Agent adapters.
 *
 * Each reincarnation is a fresh, headless, one-shot invocation of a coding-agent CLI. The
 * invariant across all three: **a brand-new zero-context session** (no --continue/--resume),
 * with unattended permission handling. Flags verified against current docs/source:
 *
 *   opencode  run "<msg>"  (no --continue ⇒ new session)      docs: opencode.ai/docs/cli
 *   codex     exec "<msg>"  (each exec is its own session)      developers.openai.com/codex/noninteractive
 *   claude    -p "<msg>" --bare  (--bare ⇒ clean slate: skips  code.claude.com/docs/en/headless
 *             CLAUDE.md/hooks/skills/MCP — ideal for unbiased rebirth)
 */
import type { AgentKind, Phase, RetryNowConfig } from './types.ts'

export interface AgentCommand {
  readonly cmd: string
  readonly args: readonly string[]
}

export class UnknownAgentError extends Error {
  constructor(agent: never) {
    super(`unknown agent: ${String(agent)}`)
    this.name = 'UnknownAgentError'
  }
}

export const AGENT_LABEL: Record<AgentKind, string> = {
  opencode: 'opencode',
  codex: 'codex',
  claude: 'claude code',
}

export function modelForPhase(config: RetryNowConfig, phase: Phase): string {
  const phaseModel =
    phase === 'analyze' ? config.analysisModel : config.improveModel
  return phaseModel || config.model
}

/**
 * The highest model effort to use when the user configured none — so an unattended loop always
 * runs at maximum reasoning effort by default. The top tier is provider-specific
 * (OpenAI's is `xhigh`, Anthropic's is `max`), so key off the model id's `provider/` prefix;
 * anything else — including an agent-default model with no id — floors to `max`.
 */
export function topVariantForModel(model: string): string {
  const provider = (model.split('/', 1)[0] ?? '').toLowerCase()
  return provider === 'openai' ? 'xhigh' : 'max'
}

/**
 * The model variant for this phase. Mirrors `modelForPhase`: the phase-specific variant wins,
 * then the shared `modelVariant`, and when BOTH are empty it falls back to the highest tier for
 * this phase's model (`topVariantForModel`) — so "no setting" means "top grade", never "off".
 * This is what lets ANALYZE and IMPROVE carry DIFFERENT top-tier variants (e.g. Anthropic `max`
 * for analyze, OpenAI `xhigh` for improve) even though one reincarnation passes one variant.
 */
export function variantForPhase(config: RetryNowConfig, phase: Phase): string {
  const phaseVariant =
    phase === 'analyze' ? config.analysisVariant : config.improveVariant
  return (
    phaseVariant ||
    config.modelVariant ||
    topVariantForModel(modelForPhase(config, phase))
  )
}

/**
 * Build the argv for one reincarnation. `message` is the full instruction handed to the
 * fresh agent (the driver composes it; see driver.ts). argv is passed directly to spawn —
 * NOT through a shell — so the prompt needs no shell escaping.
 */
export function buildAgentCommand(
  config: RetryNowConfig,
  message: string,
  phase: Phase,
): AgentCommand {
  const model = modelForPhase(config, phase)
  switch (config.agent) {
    case 'opencode': {
      const args: string[] = ['run', message]
      if (config.skipPermissions) args.push('--dangerously-skip-permissions')
      if (model) args.push('--model', model)
      const variant = variantForPhase(config, phase)
      if (variant) args.push('--variant', variant)
      if (config.agentProfile) args.push('--agent', config.agentProfile)
      return { cmd: 'opencode', args }
    }
    case 'codex': {
      const args: string[] = ['exec']
      // unattended write access; otherwise the IMPROVE phase cannot edit files.
      if (config.skipPermissions) {
        args.push('--dangerously-bypass-approvals-and-sandbox')
      } else {
        args.push('--sandbox', 'workspace-write')
      }
      args.push('--skip-git-repo-check')
      if (model) args.push('--model', model)
      const variant = variantForPhase(config, phase)
      if (variant) {
        args.push('--config', `model_reasoning_effort="${variant}"`)
      }
      args.push(message) // prompt is the trailing positional
      return { cmd: 'codex', args }
    }
    case 'claude': {
      // --bare = no CLAUDE.md/hooks/skills/MCP autoload ⇒ deterministic clean rebirth.
      const args: string[] = [
        '-p',
        message,
        '--bare',
        '--output-format',
        'text',
        '--no-session-persistence',
      ]
      if (model) args.push('--model', model)
      const variant = variantForPhase(config, phase)
      if (variant) args.push('--effort', variant)
      if (config.skipPermissions) args.push('--dangerously-skip-permissions')
      return { cmd: 'claude', args }
    }
  }
  throw new UnknownAgentError(config.agent)
}
