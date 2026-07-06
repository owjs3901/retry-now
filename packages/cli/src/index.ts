#!/usr/bin/env bun
/**
 * retry-now CLI entry.
 *
 *   retry-now init            interactive setup UI (collects 3 prompts + threshold)
 *   retry-now run [--dry-run] run the reincarnation loop to convergence
 *   retry-now status          show current loop state
 *   retry-now reset           reset the loop counter (keeps config)
 *
 * Cross-agent: the same loop drives opencode / codex / claude code per `.retry-now/config.json`.
 */
import { access, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import {
  AGENT_LABEL,
  BANNER,
  DEFAULT_REVERT_THRESHOLD,
  DEFAULT_THRESHOLD,
  loadConfig,
  type LoopState,
  resolvePaths,
  runLoop,
  slugifyTarget,
  VERSION,
} from '@retry-now/core'

import { runInit } from './init.ts'
import { runInstall } from './install.ts'

/** Absolute path to this CLI entry; baked into installed trigger files as the driver. */
const CLI_ENTRY = fileURLToPath(import.meta.url)

interface ParsedArgs {
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

function parseArgs(argv: readonly string[]): ParsedArgs {
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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function cmdRun(
  cwd: string,
  dryRun: boolean,
  commitOverride: boolean | undefined,
  waitForQuotaOverride: boolean | undefined,
): Promise<number> {
  let loaded = await loadConfig(cwd)
  if (!loaded) {
    // No config yet → run the interactive setup first (terminal only). In a non-TTY context
    // (e.g. spawned by an agent) the agent's /retry-now command writes the config beforehand.
    if (!process.stdin.isTTY) {
      console.error('설정이 없다. 먼저 `retry-now init` 을 실행하라.')
      return 1
    }
    console.log('설정이 없다 — 먼저 설정을 진행한다.')
    const code = await runInit(cwd)
    if (code !== 0) return code
    loaded = await loadConfig(cwd)
    if (!loaded) return 1
  }
  const config =
    commitOverride === undefined
      ? loaded
      : { ...loaded, commitPerIteration: commitOverride }
  const result = await runLoop(config, {
    cwd,
    dryRun,
    waitForQuota: waitForQuotaOverride ?? config.waitForQuota,
  })
  return result.status === 'error' ? 1 : 0
}

async function readState(path: string): Promise<LoopState | null> {
  if (!(await exists(path))) return null
  try {
    return JSON.parse(await readFile(path, 'utf8')) as LoopState
  } catch {
    return null
  }
}

function describeState(state: LoopState | null, threshold: number): string {
  if (!state) return '(아직 실행된 적 없음)'
  return `${state.status}  iter=${state.iteration}  streak=${state.noImprovementStreak}/${threshold}`
}

async function cmdStatus(cwd: string): Promise<number> {
  const config = await loadConfig(cwd)
  if (!config) {
    console.error('설정이 없다. 먼저 `retry-now init` 을 실행하라.')
    return 1
  }
  const paths = resolvePaths(cwd)
  console.log(BANNER)
  console.log(`agent      : ${AGENT_LABEL[config.agent]}`)
  console.log(
    `models     : analyze=${config.analysisModel || config.model || 'agent default'} / improve=${config.improveModel || config.model || 'agent default'}`,
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

  if (config.targets.length === 0) {
    console.log('mode       : 전체 레포 단일 윤회')
    console.log(
      `state      : ${describeState(await readState(paths.state), config.threshold)}`,
    )
    return 0
  }

  console.log(`mode       : 패키지별 분할 (${config.targets.length} 타겟)`)
  for (const target of config.targets) {
    const tp = resolvePaths(cwd, slugifyTarget(target))
    console.log(
      `  ◆ ${target}: ${describeState(await readState(tp.state), config.threshold)}`,
    )
  }
  return 0
}

async function cmdReset(cwd: string): Promise<number> {
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
  await writeFile(paths.state, `${JSON.stringify(fresh, null, 2)}\n`, 'utf8')
  if (await exists(paths.stop)) await rm(paths.stop)
  console.log('윤회 카운터를 리셋했다. (config는 유지) 다시 `retry-now run`.')
  return 0
}

async function main(): Promise<number> {
  const rawArgs = process.argv.slice(2)
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
      return runInit(cwd)
    case 'run':
      return cmdRun(cwd, dryRun, commitOverride, waitForQuotaOverride)
    case 'install':
      return runInstall(CLI_ENTRY, target, cwd, personal)
    case 'status':
      return cmdStatus(cwd)
    case 'reset':
      return cmdReset(cwd)
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

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    )
    process.exit(1)
  })
