import * as p from '@clack/prompts'
import type { AgentKind } from '@retry-now/core'

export type RoleAgentSettings = {
  readonly analysisAgent: AgentKind
  readonly analysisModel: string
  readonly analysisVariant: string
  readonly improveAgent: AgentKind
  readonly improveModel: string
  readonly improveVariant: string
  readonly reviewAgent: AgentKind
  readonly reviewModel: string
  readonly reviewVariant: string
}

const AGENT_OPTIONS: { value: AgentKind; label: string; hint: string }[] = [
  { value: 'opencode', label: 'opencode', hint: 'opencode run' },
  { value: 'codex', label: 'codex', hint: 'codex exec' },
  { value: 'claude', label: 'claude code', hint: 'claude -p --bare' },
]

export type AgentSettingsPrompts = {
  readonly select: (options: {
    readonly message: string
    readonly options: {
      readonly value: AgentKind
      readonly label: string
      readonly hint: string
    }[]
    readonly initialValue: AgentKind
  }) => Promise<AgentKind | symbol>
  readonly text: (options: {
    readonly message: string
    readonly placeholder: string
    readonly defaultValue: string
  }) => Promise<string | symbol>
  readonly isCancel: (value: unknown) => value is symbol
}

const CLACK_PROMPTS: AgentSettingsPrompts = {
  select: p.select,
  text: p.text,
  isCancel: p.isCancel,
}

function variantSetting(agent: AgentKind): string {
  switch (agent) {
    case 'opencode':
      return 'opencode --variant'
    case 'codex':
      return 'Codex model_reasoning_effort'
    case 'claude':
      return 'Claude Code --effort'
  }
}

async function chooseAgent(
  message: string,
  initialValue: AgentKind,
  prompts: AgentSettingsPrompts,
): Promise<AgentKind | null> {
  const value = await prompts.select({
    message,
    options: AGENT_OPTIONS,
    initialValue,
  })
  return prompts.isCancel(value) ? null : value
}

async function chooseText(
  message: string,
  prompts: AgentSettingsPrompts,
): Promise<string | null> {
  const value = await prompts.text({
    message,
    placeholder: 'provider/model or max / xhigh',
    defaultValue: '',
  })
  return prompts.isCancel(value) ? null : value
}

export async function askRoleAgentSettings(
  prompts: AgentSettingsPrompts = CLACK_PROMPTS,
): Promise<RoleAgentSettings | null> {
  const analysisAgent = await chooseAgent(
    '분석 세션에 사용할 agent CLI는?',
    'opencode',
    prompts,
  )
  if (!analysisAgent) return null
  const analysisModel = await chooseText(
    '분석 모델 id (provider/model). 비워두면 agent 기본값.',
    prompts,
  )
  if (analysisModel === null) return null
  const analysisVariant = await chooseText(
    `분석 variant (${variantSetting(analysisAgent)}). 비워두면 최고 등급 자동.`,
    prompts,
  )
  if (analysisVariant === null) return null

  const improveAgent = await chooseAgent(
    '각 item 구현 세션에 사용할 agent CLI는?',
    analysisAgent,
    prompts,
  )
  if (!improveAgent) return null
  const improveModel = await chooseText(
    '구현 모델 id (provider/model). 비우면 같은 CLI의 공용 model, 다른 CLI면 agent 기본값.',
    prompts,
  )
  if (improveModel === null) return null
  const improveVariant = await chooseText(
    `구현 variant (${variantSetting(improveAgent)}). 비워두면 최고 등급 자동.`,
    prompts,
  )
  if (improveVariant === null) return null

  const reviewAgent = await chooseAgent(
    '각 item 독립 검토 세션에 사용할 agent CLI는?',
    improveAgent,
    prompts,
  )
  if (!reviewAgent) return null
  const reviewModel = await chooseText(
    '검토 모델 id (provider/model). 비우면 같은 CLI의 구현 모델, 다른 CLI면 agent 기본값.',
    prompts,
  )
  if (reviewModel === null) return null
  const reviewVariant = await chooseText(
    `검토 variant (${variantSetting(reviewAgent)}). 비우면 같은 CLI의 구현 variant, 다른 CLI면 최고 등급 자동.`,
    prompts,
  )
  if (reviewVariant === null) return null

  return {
    analysisAgent,
    analysisModel,
    analysisVariant,
    improveAgent,
    improveModel,
    improveVariant,
    reviewAgent,
    reviewModel,
    reviewVariant,
  }
}
