#!/usr/bin/env bun
/**
 * retry-now CLI entry.
 *
 *   retry-now init            interactive setup UI (collects 3 prompts + threshold)
 *   retry-now run [--dry-run] run the reincarnation loop to convergence
 *   retry-now status          show current loop state
 *   retry-now recover         recover a loop whose driver was killed mid-batch
 *   retry-now reset           reset the loop counter (keeps config)
 *
 * Cross-agent: the same loop drives opencode / codex / claude code per `.retry-now/config.json`.
 */
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AGENT_LABEL,
  agentForRole,
  BANNER,
  createCommandRunner,
  DEFAULT_REVERT_THRESHOLD,
  DEFAULT_THRESHOLD,
  isPidAlive,
  loadConfig,
  type LoopState,
  modelForRole,
  readDriverLock,
  recoverProject,
  resolvePaths,
  runLoop,
  slugifyTarget,
  spawnVerifyCommand,
  variantForRole,
  VERSION,
} from '@retry-now/core'

import { runInit } from './init.ts'
import { runInstall } from './install.ts'

/** Absolute path to this CLI entry; baked into installed trigger files as the driver. */
const CLI_ENTRY = fileURLToPath(import.meta.url)

export interface ParsedArgs {
  readonly command: string
  /** second positional, e.g. the agent for `install <agent>` */
  readonly target: string
  readonly cwd: string
  readonly dryRun: boolean
  /** undefined = use config; true/false = override commitPerIteration for this run only */
  readonly commitOverride: boolean | undefined
  /** undefined = use config; true/false = override waitForQuota for this run only */
  readonly waitForQuotaOverride: boolean | undefined
  /** install to the user-home location instead of the project */
  readonly personal: boolean
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let command = ''
  let target = ''
  let cwd = process.cwd()
  let dryRun = false
  let commitOverride: boolean | undefined
  let waitForQuotaOverride: boolean | undefined
  let personal = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') dryRun = true
    else if (a === '--no-commit') commitOverride = false
    else if (a === '--commit') commitOverride = true
    else if (a === '--wait-for-quota') waitForQuotaOverride = true
    else if (a === '--no-wait-for-quota') waitForQuotaOverride = false
    else if (a === '--personal') personal = true
    else if (a === '--cwd') {
      const next = argv[i + 1]
      if (next) {
        cwd = next
        i++
      }
    } else if (a && !a.startsWith('-')) {
      if (!command) command = a
      else if (!target) target = a
    }
  }
  return {
    command,
    target,
    cwd,
    dryRun,
    commitOverride,
    waitForQuotaOverride,
    personal,
  }
}

const USAGE = `retry-now v${VERSION} · 지금 바로 윤회 — 컨텍스트가 매 생마다 0으로 리셋되는 자율 개선 윤회

usage:
  retry-now init                 대화형 설정 UI (분석/개선방향/완료체크 + 수렴 임계값 + 커밋 여부)
  retry-now run [옵션]           윤회 실행 (수렴할 때까지)
  retry-now install <agent>      /retry-now 트리거 설치 (opencode | claude | codex)
  retry-now status               현재 윤회 상태 보기
  retry-now recover              중단된 윤회 복구 (리뷰 통과분 커밋 + 미리뷰 아이템 롤백)
  retry-now reset                윤회 카운터 리셋 (config 유지)
  retry-now version              현재 버전 출력 (-v | --version)

옵션:
  --cwd <path>   대상 프로젝트 루트 (기본: 현재 디렉토리)
  --personal     install 시 프로젝트가 아닌 사용자 홈(전역)에 설치
  --dry-run      에이전트 호출 없이 제어 흐름만 시뮬레이션
  --no-commit    이번 실행만 윤회별 git 커밋 끄기 (config 기본값 override)
  --commit       이번 실행만 윤회별 git 커밋 켜기 (config 기본값 override)
  --wait-for-quota     전 계정 쿼터 소진 시 충전될 때까지 대기 후 자동 재개 (config override)
  --no-wait-for-quota  쿼터 소진 시 대기 없이 paused-quota로 정지 (config override)

agents:
  opencode → .opencode/command/retry-now.md   (호출: /retry-now)
  claude   → .claude/commands/retry-now.md     (호출: /retry-now)
  codex    → .agents/skills/retry-now/SKILL.md  (호출: $retry-now)`

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export type RunDependencies = {
  readonly loadConfig: typeof loadConfig
  readonly runInit: typeof runInit
  readonly runLoop: typeof runLoop
  readonly stdinIsTTY: boolean
}

const RUN_DEPENDENCIES: RunDependencies = {
  loadConfig,
  runInit,
  runLoop,
  stdinIsTTY: process.stdin.isTTY,
}

export async function cmdRun(
  cwd: string,
  dryRun: boolean,
  commitOverride: boolean | undefined,
  waitForQuotaOverride: boolean | undefined,
  dependencies: RunDependencies = RUN_DEPENDENCIES,
): Promise<number> {
  let loaded = await dependencies.loadConfig(cwd)
  if (!loaded) {
    // No config yet → run the interactive setup first (terminal only). In a non-TTY context
    // (e.g. spawned by an agent) the agent's /retry-now command writes the config beforehand.
    if (!dependencies.stdinIsTTY) {
      console.error('설정이 없다. 먼저 `retry-now init` 을 실행하라.')
      return 1
    }
    console.log('설정이 없다 — 먼저 설정을 진행한다.')
    const code = await dependencies.runInit(cwd)
    if (code !== 0) return code
    loaded = await dependencies.loadConfig(cwd)
    if (!loaded) return 1
  }
  const config =
    commitOverride === undefined
      ? loaded
      : { ...loaded, commitPerIteration: commitOverride }
  const result = await dependencies.runLoop(config, {
    cwd,
    dryRun,
    waitForQuota: waitForQuotaOverride ?? config.waitForQuota,
  })
  return result.status === 'error' ? 1 : 0
}

export async function readState(path: string): Promise<LoopState | null> {
  if (!(await exists(path))) return null
  try {
    return JSON.parse(await readFile(path, 'utf8')) as LoopState
  } catch {
    return null
  }
}

export interface StateView {
  /** an IMPROVE transaction is still recorded as in flight, so a killed batch needs recovering */
  readonly pendingTransaction: boolean
  /** no LIVE driver holds the project lock */
  readonly driverKilled: boolean
}

export function describeState(
  state: LoopState | null,
  threshold: number,
  view: StateView,
): string {
  if (!state) return '(아직 실행된 적 없음)'
  const base = `${state.status}  iter=${state.iteration}  streak=${state.noImprovementStreak}/${threshold}`
  // Two shapes mean "a driver was killed without recording a terminal status": an explicit
  // `interrupted` (a later driver startup already corrected it), or a `running` claim with no live
  // driver behind it — which is a LIE no reader could otherwise detect. Either way there may be
  // reviewed-but-uncommitted work in the tree, so it must never read as an ordinary state.
  const stale =
    state.status === 'interrupted' ||
    (state.status === 'running' && view.driverKilled)
  if (!stale) return base
  // Only point at `recover` while an in-flight transaction record proves work is pending; otherwise
  // the interruption is already resolved and the advice would be stale.
  return view.pendingTransaction
    ? `${base}  ⚠ 드라이버가 비정상 종료됨 — \`retry-now recover\` 로 복구하세요 (먼저 복구하지 않고 재개하면 리뷰를 통과한 미커밋 작업이 사라집니다)`
    : `${base}  (복구할 중단 배치 없음 — \`retry-now run\` 으로 이어서 진행)`
}

export async function cmdStatus(cwd: string): Promise<number> {
  const config = await loadConfig(cwd)
  if (!config) {
    console.error('설정이 없다. 먼저 `retry-now init` 을 실행하라.')
    return 1
  }
  const paths = resolvePaths(cwd)
  console.log(BANNER)
  console.log(
    `agents     : analyze=${AGENT_LABEL[agentForRole(config, 'analyze')]} / improve=${AGENT_LABEL[agentForRole(config, 'improve')]} / review=${AGENT_LABEL[agentForRole(config, 'review')]}`,
  )
  console.log(
    `models     : analyze=${modelForRole(config, 'analyze') || 'agent default'} / improve=${modelForRole(config, 'improve') || 'agent default'} / review=${modelForRole(config, 'review') || 'agent default'}`,
  )
  console.log(
    `variants   : analyze=${variantForRole(config, 'analyze')} / improve=${variantForRole(config, 'improve')} / review=${variantForRole(config, 'review')}`,
  )
  console.log(`threshold  : ${config.threshold} 생 연속 개선없음이면 맺어짐`)
  console.log(
    `revert-th  : ${config.revertThreshold} 생 연속 전체 리버트면 맺어짐`,
  )
  console.log(
    `bench      : ${config.benchCommand ? `${config.benchCommand} (×${config.benchRuns})` : '미설정'}`,
  )
  console.log(`max-iters  : ${config.maxIterations}`)
  if (await exists(paths.stop))
    console.log('STOP       : sentinel 존재 (다음 경계에서 정지)')
  if (await exists(paths.headQuarantine))
    console.log(
      'HEAD       : unauthorized commit 격리 중 (HEAD 복원 또는 retry-now reset 필요)',
    )

  // A driver that stops for any reason of its own releases its lock, so no live holder means the
  // previous driver is gone — whatever `state.json` still claims.
  const holder = await readDriverLock(paths.driverLock)
  const driverKilled = holder === null || !isPidAlive(holder.pid)
  if (holder !== null) {
    console.log(
      `driver     : pid ${holder.pid} ${driverKilled ? '죽음 (stale lock)' : '실행 중'} · 시작 ${holder.startedAt}`,
    )
  }

  if (config.targets.length === 0) {
    console.log('mode       : 전체 레포 단일 윤회')
    console.log(
      `state      : ${describeState(
        await readState(paths.state),
        config.threshold,
        {
          pendingTransaction: await exists(paths.iterationRecord),
          driverKilled,
        },
      )}`,
    )
    return 0
  }

  console.log(`mode       : 패키지별 분할 (${config.targets.length} 타겟)`)
  for (const target of config.targets) {
    const tp = resolvePaths(cwd, slugifyTarget(target))
    console.log(
      `  ◆ ${target}: ${describeState(
        await readState(tp.state),
        config.threshold,
        {
          pendingTransaction: await exists(tp.iterationRecord),
          driverKilled,
        },
      )}`,
    )
  }
  return 0
}

/**
 * `retry-now recover` — reconstruct a life whose driver was killed mid-batch.
 *
 * A host/editor restart during a multi-hour 윤회 leaves reviewed-but-uncommitted items in the working
 * tree and a `state.json` still claiming `running`. Without this, starting the next life absorbs those
 * changes into a fresh baseline and their provenance, evidence, and review verdict are lost for good.
 */
export async function cmdRecover(
  cwd: string,
  recover: typeof recoverProject = recoverProject,
): Promise<number> {
  console.log(BANNER)
  const { reports, code } = await recover(cwd, {
    commandRunner: createCommandRunner(spawnVerifyCommand),
  })
  for (const report of reports) {
    for (const line of report.lines) console.log(line)
  }
  const recovered = reports.filter((report) => report.status === 'recovered')
  if (recovered.length > 0) {
    const kept = recovered.reduce((sum, r) => sum + r.keptCount, 0)
    const rolled = recovered.flatMap((r) => r.rolledBack)
    console.log('')
    console.log(
      `복구 완료: 리뷰 통과 ${kept}건 보존${rolled.length > 0 ? `, 미리뷰 item ${rolled.join(', ')} 롤백` : ''}. 이어서 \`retry-now run\`.`,
    )
  }
  return code
}

export async function cmdReset(cwd: string): Promise<number> {
  const paths = resolvePaths(cwd)
  if (!(await exists(paths.config))) {
    console.error('설정이 없다. 먼저 `retry-now init` 을 실행하라.')
    return 1
  }
  const now = new Date().toISOString()
  const cfg = await loadConfig(cwd)
  const fresh: LoopState = {
    status: 'running',
    iteration: 0,
    noImprovementStreak: 0,
    threshold: cfg?.threshold ?? DEFAULT_THRESHOLD,
    revertStreak: 0,
    revertThreshold: cfg?.revertThreshold ?? DEFAULT_REVERT_THRESHOLD,
    startedAt: now,
    updatedAt: now,
  }
  const statePathsFor =
    cfg && cfg.targets.length > 0
      ? cfg.targets.map((target) => resolvePaths(cwd, slugifyTarget(target)))
      : [paths]
  await Promise.all(
    statePathsFor.map(async (target) => {
      await mkdir(dirname(target.state), { recursive: true })
      await writeFile(
        target.state,
        `${JSON.stringify(fresh, null, 2)}\n`,
        'utf8',
      )
      // Reset means "this project has no history to continue from". An in-flight IMPROVE
      // transaction record is exactly such history: left behind, it describes a life number the
      // fresh counter will never reach, so `retry-now recover` would reason about a batch that no
      // longer exists. Cleared per target, because each one owns its own record.
      await rm(target.iterationRecord, { force: true })
    }),
  )
  if (await exists(paths.stop)) await rm(paths.stop)
  if (await exists(paths.headQuarantine)) await rm(paths.headQuarantine)
  console.log('윤회 카운터를 리셋했다. (config는 유지) 다시 `retry-now run`.')
  return 0
}

export type CliCommands = {
  readonly init: typeof runInit
  readonly run: typeof cmdRun
  readonly install: typeof runInstall
  readonly status: typeof cmdStatus
  readonly recover: typeof cmdRecover
  readonly reset: typeof cmdReset
}

const CLI_COMMANDS: CliCommands = {
  init: runInit,
  run: cmdRun,
  install: runInstall,
  status: cmdStatus,
  recover: cmdRecover,
  reset: cmdReset,
}

export async function main(
  rawArgs: readonly string[] = process.argv.slice(2),
  commands: CliCommands = CLI_COMMANDS,
): Promise<number> {
  if (rawArgs.includes('--version') || rawArgs.includes('-v')) {
    console.log(`retry-now v${VERSION}`)
    return 0
  }
  const {
    command,
    target,
    cwd,
    dryRun,
    commitOverride,
    waitForQuotaOverride,
    personal,
  } = parseArgs(rawArgs)
  switch (command) {
    case 'version':
      console.log(`retry-now v${VERSION}`)
      return 0
    case 'init':
      return commands.init(cwd)
    case 'run':
      return commands.run(cwd, dryRun, commitOverride, waitForQuotaOverride)
    case 'install':
      return commands.install(CLI_ENTRY, target, cwd, personal)
    case 'status':
      return commands.status(cwd)
    case 'recover':
      return commands.recover(cwd)
    case 'reset':
      return commands.reset(cwd)
    case '':
    case 'help':
      console.log(USAGE)
      return 0
    default:
      console.error(`알 수 없는 명령: ${command}\n`)
      console.log(USAGE)
      return 1
  }
}

export async function runCliEntry(
  run: () => Promise<number> = main,
  exit: (code: number) => void = process.exit,
): Promise<void> {
  try {
    exit(await run())
  } catch (err) {
    console.error(
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    )
    exit(1)
  }
}

const moduleMetadata = import.meta
if (moduleMetadata.main) void runCliEntry()
