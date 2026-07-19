import {
  access,
  appendFile,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'

import { tool, type ToolDefinition } from '@opencode-ai/plugin'
import {
  createCliSpawnBackend,
  type DriverOptions,
  type DriverResult,
  loadConfig,
  loadState,
  type Paths,
  resolvePaths,
  type RetryNowConfig,
  runLoop,
  slugifyTarget,
} from '@retry-now/core'

import { createOpencodeNativeBackend } from './native/backend.ts'
import type { NativeSessionClient } from './native/client.ts'
import type { LoopController } from './native/controller.ts'

export interface RetryNowToolContext {
  readonly directory: string
  readonly sessionID: string
}

export interface RetryNowStartArguments {
  readonly dryRun?: boolean | undefined
}

type RunLoop = (
  config: RetryNowConfig,
  options: DriverOptions,
) => Promise<DriverResult>

export interface RetryNowToolDependencies {
  readonly client: NativeSessionClient
  readonly controller: LoopController
  readonly runLoop?: RunLoop
}

type LoopCompletion =
  | { readonly kind: 'result'; readonly status: DriverResult['status'] }
  | { readonly kind: 'error'; readonly message: string }

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function describeState(
  paths: Paths,
  config: RetryNowConfig,
): Promise<{ readonly text: string; readonly running: boolean }> {
  if (!(await exists(paths.state))) {
    return { text: '(아직 실행된 적 없음)', running: false }
  }
  const state = await loadState(paths, config.threshold, config.revertThreshold)
  return {
    text: `${state.status}  iter=${state.iteration}  streak=${state.noImprovementStreak}/${config.threshold}`,
    running: state.status === 'running',
  }
}

async function describeCurrent(paths: Paths): Promise<string | undefined> {
  if (!(await exists(paths.current))) return undefined
  try {
    const current: unknown = JSON.parse(await readFile(paths.current, 'utf8'))
    if (typeof current !== 'object' || current === null) return undefined
    const iteration = Reflect.get(current, 'iteration')
    const phase = Reflect.get(current, 'phase')
    if (typeof iteration !== 'number' || typeof phase !== 'string')
      return undefined
    const stage = Reflect.get(current, 'stage')
    return `#${String(iteration).padStart(4, '0')} ${phase}${typeof stage === 'string' ? `/${stage}` : ''}`
  } catch {
    return undefined
  }
}

export class RetryNowToolRuntime {
  private readonly completions = new Map<string, LoopCompletion>()
  private readonly detached = new Map<string, Promise<void>>()

  constructor(private readonly dependencies: RetryNowToolDependencies) {}

  async start(
    arguments_: RetryNowStartArguments,
    context: RetryNowToolContext,
  ): Promise<string> {
    const config = await loadConfig(context.directory)
    if (config === null) {
      return '설정이 없다 — `/retry-now` 커맨드의 설정 인터뷰를 먼저 진행하라. 윤회를 시작하지 않았다.'
    }
    if (!this.dependencies.controller.registerLoop(context.directory)) {
      return '이미 이 프로젝트에서 윤회가 실행 중이다. `retrynow_status`로 상태를 확인하거나 `retrynow_stop`으로 정지하라.'
    }

    this.completions.delete(context.directory)
    const backend = createOpencodeNativeBackend({
      client: this.dependencies.client,
      controller: this.dependencies.controller,
      parentSessionID: context.sessionID,
      directory: context.directory,
      fallback: createCliSpawnBackend(),
    })
    const task = this.runDetached(config, context.directory, {
      cwd: context.directory,
      dryRun: arguments_.dryRun ?? false,
      waitForQuota: config.waitForQuota,
      backend,
    })
    this.detached.set(context.directory, task)
    void task

    return '🌀 윤회를 시작합니다 — 각 단계는 `retry-now #NNNN …` 제목의 child session으로 나타납니다. 진행은 `retrynow_status`, 정지는 `retrynow_stop`을 사용하세요.'
  }

  async status(context: RetryNowToolContext): Promise<string> {
    const config = await loadConfig(context.directory)
    if (config === null) {
      return '설정이 없다. 먼저 `/retry-now` 커맨드의 설정 인터뷰를 진행하라.'
    }
    const paths = resolvePaths(context.directory)
    const activity = this.dependencies.controller.getLoopStatus(
      context.directory,
    )
    const lines = [
      'retry-now 상태',
      `process    : ${activity ?? 'inactive'}`,
      `threshold  : ${config.threshold} 생 연속 개선없음이면 맺어짐`,
    ]
    const completion = this.completions.get(context.directory)
    if (completion?.kind === 'result')
      lines.push(`last       : ${completion.status}`)
    if (completion?.kind === 'error')
      lines.push(`last       : error — ${completion.message}`)
    if (await exists(paths.stop))
      lines.push('STOP       : sentinel 존재 (다음 경계에서 정지)')

    let interrupted = false
    if (config.targets.length === 0) {
      lines.push('mode       : 전체 레포 단일 윤회')
      const state = await describeState(paths, config)
      lines.push(`state      : ${state.text}`)
      const current = await describeCurrent(paths)
      if (current !== undefined) lines.push(`current    : ${current}`)
      interrupted = state.running && activity === undefined
    } else {
      lines.push(`mode       : 패키지별 분할 (${config.targets.length} 타겟)`)
      for (const target of config.targets) {
        const targetPaths = resolvePaths(
          context.directory,
          slugifyTarget(target),
        )
        const state = await describeState(targetPaths, config)
        lines.push(`  ◆ ${target}: ${state.text}`)
        const current = await describeCurrent(targetPaths)
        if (current !== undefined) lines.push(`    current: ${current}`)
        interrupted ||= state.running
      }
      interrupted &&= activity === undefined
    }
    if (interrupted) {
      lines.push(
        'state.json은 running이지만 이 프로세스의 활성 윤회가 없어 중단된 것으로 보입니다. `retrynow_start`로 재개할 수 있습니다.',
      )
    }
    return lines.join('\n')
  }

  async stop(context: RetryNowToolContext): Promise<string> {
    const paths = resolvePaths(context.directory)
    await mkdir(paths.dir, { recursive: true })
    await writeFile(paths.stop, '', 'utf8')
    this.dependencies.controller.markLoopStopping(context.directory)
    await this.dependencies.controller.abortActive(context.directory)
    return 'STOP을 기록했다 — 윤회는 다음 경계에서 정지하며, 현재 실행 중인 active phase는 즉시 중단을 요청했다.'
  }

  async waitForCompletion(directory: string): Promise<void> {
    await this.detached.get(directory)
  }

  private async runDetached(
    config: RetryNowConfig,
    directory: string,
    options: DriverOptions,
  ): Promise<void> {
    try {
      const result = await (this.dependencies.runLoop ?? runLoop)(
        config,
        options,
      )
      this.completions.set(directory, { kind: 'result', status: result.status })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.completions.set(directory, { kind: 'error', message })
      const paths = resolvePaths(directory)
      try {
        await mkdir(paths.logsDir, { recursive: true })
        await appendFile(
          join(paths.logsDir, 'plugin.log'),
          `[${new Date().toISOString()}] detached loop error: ${message}\n`,
          'utf8',
        )
      } catch (logError) {
        const detail =
          logError instanceof Error ? logError.message : String(logError)
        console.error(`retry-now detached loop log failure: ${detail}`)
      }
    } finally {
      this.dependencies.controller.unregisterLoop(directory)
    }
  }
}

export function createRetryNowTools(
  runtime: RetryNowToolRuntime,
): Record<string, ToolDefinition> {
  return {
    retrynow_start: tool({
      description:
        '현재 프로젝트의 retry-now 윤회를 백그라운드에서 시작합니다.',
      args: { dryRun: tool.schema.boolean().optional() },
      execute: (arguments_, context) => runtime.start(arguments_, context),
    }),
    retrynow_status: tool({
      description: '현재 프로젝트의 retry-now 상태와 활성 윤회를 확인합니다.',
      args: {},
      execute: (_arguments, context) => runtime.status(context),
    }),
    retrynow_stop: tool({
      description: '현재 프로젝트의 retry-now 윤회를 안전하게 정지합니다.',
      args: {},
      execute: (_arguments, context) => runtime.stop(context),
    }),
  }
}
