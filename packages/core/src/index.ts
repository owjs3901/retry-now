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
  buildAgentCommand,
  topVariantForModel,
  variantForPhase,
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
} from './config.ts'
export {
  type DriverResult,
  runDriverCli,
  runLoop,
  runProjectLoop,
  type RunProjectOptions,
} from './driver.ts'
export {
  buildFrontend,
  buildFrontendBody,
  type FrontendFile,
  type FrontendInstallResult,
  installFrontend,
} from './frontends.ts'
export {
  commitPaths,
  type GitResult,
  type GitRunner,
  isGitRepo,
  runGit,
  statusPorcelain,
} from './git.ts'
export {
  acquireDriverLock,
  type DriverLock,
  isPidAlive,
  type LockResult,
  releaseDriverLock,
} from './lock.ts'
export { DIR, pad, type Paths, resolvePaths, slugifyTarget } from './paths.ts'
export { buildAnalyzePrompt, buildImprovePrompt } from './prompts.ts'
export { scaffold } from './scaffold.ts'
export { loadState, saveState } from './state.ts'
export { BANNER, converged, OATH, oathBlock, rebirth } from './theme.ts'
export type {
  AgentKind,
  AnalyzeResult,
  Current,
  DriverOptions,
  ImproveResult,
  LoopState,
  LoopStatus,
  Phase,
  RetryNowConfig,
  Signal,
} from './types.ts'
export { VERSION } from './version.ts'
