import type {
  AgentRole,
  ImproveStage,
  Phase,
  PlannedImprovement,
  RetryNowConfig,
  Signal,
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
  /**
   * Optional core-owned probe resolving to the phase's terminal signal once the agent has written
   * it (else null). A native backend gates completion on THIS, not on session lifecycle events,
   * because a child's turn goes idle while its own background sub-agents run and the prompt HTTP
   * await is unreliable. `CliSpawnBackend` ignores it — process exit is authoritative.
   */
  readonly completionProbe?: () => Promise<Signal | null>
  readonly log: (line: string) => void
}

export interface AgentBackend {
  run(request: PhaseInvocationRequest): Promise<PhaseRunResult>
}
