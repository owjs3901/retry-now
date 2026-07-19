import type {
  AgentRole,
  ImproveStage,
  Phase,
  PlannedImprovement,
  RetryNowConfig,
} from './types.ts'

export type PhaseRunResult =
  | { readonly kind: 'exit'; readonly code: number }
  | { readonly kind: 'quota' }
  | { readonly kind: 'aborted' }

export interface PhaseInvocationRequest {
  readonly message: string
  readonly role: AgentRole
  readonly title: string
  readonly config: RetryNowConfig
  readonly logPath: string
  readonly cwd: string
  readonly model: string
  readonly iteration: number
  readonly phase: Phase
  readonly stage?: ImproveStage
  readonly item?: PlannedImprovement
  readonly itemIndex?: number
  readonly reportPath?: string
  readonly timeoutMs?: number
  readonly log: (line: string) => void
}

export interface AgentBackend {
  run(request: PhaseInvocationRequest): Promise<PhaseRunResult>
}
