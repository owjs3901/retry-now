/**
 * `@retry-now/core` — public API.
 *
 * 지금 바로 윤회: an autonomous improvement loop whose context is reborn at 0 every
 * iteration. The only thing that survives a life is the driver-owned consecutive
 * no-improvement streak; the loop ends when the improvement is 맺어진다 (converged).
 */

export {
  AGENT_LABEL,
  type AgentCommand,
  agentForRole,
  buildAgentCommand,
  modelForPhase,
  modelForRole,
  topVariantForModel,
  variantForPhase,
  variantForRole,
} from './agents.ts'
export {
  AGENT_KINDS,
  ConfigError,
  DEFAULT_BENCH_RUNS,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_REVERT_THRESHOLD,
  DEFAULT_THRESHOLD,
  DEFAULTS,
  isAgentKind,
  loadConfig,
  normalizeConfig,
  type RawRetryNowConfig,
} from './config.ts'
export {
  buildFrontend,
  buildFrontendBody,
  type FrontendFile,
  type FrontendInstallResult,
  installFrontend,
} from './frontends.ts'
export {
  commitPaths,
  formatIterationCommitMessage,
  type GitResult,
  type GitRunner,
  isGitRepo,
  runGit,
  statusPorcelain,
} from './git.ts'
export {
  buildItemImplementPrompt,
  buildItemReviewPrompt,
} from './improve-prompts.ts'
export {
  acquireDriverLock,
  type DriverLock,
  isPidAlive,
  type LockResult,
  releaseDriverLock,
} from './lock.ts'
export {
  type DriverResult,
  runDriverCli,
  runLoop,
  runProjectLoop,
  type RunProjectOptions,
} from './loop-driver.ts'
export { DIR, pad, type Paths, resolvePaths, slugifyTarget } from './paths.ts'
export { type ImproveItemPaths, resolveImproveItemPaths } from './paths.ts'
export { buildAnalyzePrompt, buildImprovePrompt } from './prompts.ts'
export { scaffold } from './scaffold.ts'
export { loadState, saveState } from './state.ts'
export { BANNER, converged, OATH, oathBlock, rebirth } from './theme.ts'
export type {
  AgentKind,
  AgentRole,
  AnalyzeResult,
  Current,
  DriverOptions,
  ImproveResult,
  ImproveStage,
  LoopState,
  LoopStatus,
  Phase,
  RetryNowConfig,
  Signal,
} from './types.ts'
export { VERSION } from './version.ts'
