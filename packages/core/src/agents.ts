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
import type { AgentKind, RetryNowConfig } from './types.ts'

export interface AgentCommand {
  readonly cmd: string
  readonly args: readonly string[]
}

export const AGENT_LABEL: Record<AgentKind, string> = {
  opencode: 'opencode',
  codex: 'codex',
  claude: 'claude code',
}

/**
 * Build the argv for one reincarnation. `message` is the full instruction handed to the
 * fresh agent (the driver composes it; see driver.ts). argv is passed directly to spawn —
 * NOT through a shell — so the prompt needs no shell escaping.
 */
export function buildAgentCommand(
  config: RetryNowConfig,
  message: string,
): AgentCommand {
  switch (config.agent) {
    case 'opencode': {
      const args: string[] = ['run', message]
      if (config.skipPermissions) args.push('--dangerously-skip-permissions')
      if (config.model) args.push('--model', config.model)
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
      if (config.model) args.push('--model', config.model)
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
      if (config.model) args.push('--model', config.model)
      if (config.skipPermissions) args.push('--dangerously-skip-permissions')
      return { cmd: 'claude', args }
    }
  }
}
