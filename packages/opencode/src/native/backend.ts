import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  type AgentBackend,
  agentForRole,
  type PhaseInvocationRequest,
  type PhaseRunResult,
} from '@retry-now/core'

import type {
  NativeClientResult,
  NativePromptResponse,
  NativeSessionClient,
} from './client.ts'
import {
  ChildSessionError,
  ChildSessionTimeoutError,
  ChildSessionWaitAbortedError,
  type LoopController,
} from './controller.ts'
import { parseModel } from './model.ts'
import { classifySdkError } from './sdk-error.ts'

const DEFAULT_PHASE_TIMEOUT_MS = 30 * 60 * 1_000
const ABORT_TIMEOUT_MS = 10_000

export interface OpencodeNativeBackendDependencies {
  readonly client: NativeSessionClient
  readonly controller: LoopController
  readonly parentSessionID: string
  readonly directory: string
  readonly fallback: AgentBackend
  readonly defaultPhaseTimeoutMs?: number
  readonly abortTimeoutMs?: number
}

class NativeClientCallError extends Error {
  override readonly name = 'NativeClientCallError'

  constructor(readonly detail: unknown) {
    super('opencode SDK call failed')
  }
}

type RaceResult =
  | { readonly kind: 'prompt'; readonly response: NativePromptResponse }
  | { readonly kind: 'idle' }
  | { readonly kind: 'timeout' }
type PromptResult = Extract<RaceResult, { readonly kind: 'prompt' }>
type IdleResult = Extract<RaceResult, { readonly kind: 'idle' }>
type TimeoutResult = Extract<RaceResult, { readonly kind: 'timeout' }>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isMessageAbortedError(value: unknown): boolean {
  return isRecord(value) && value.name === 'MessageAbortedError'
}

function errorMessage(error: unknown): string {
  if (error instanceof NativeClientCallError) return String(error.detail)
  return error instanceof Error ? error.message : String(error)
}

function dataOrThrow<T>(result: NativeClientResult<T>): T {
  if (result.data === undefined) throw new NativeClientCallError(result.error)
  return result.data
}

function resultLabel(result: PhaseRunResult): string {
  switch (result.kind) {
    case 'exit':
      return `exit ${result.code}`
    case 'quota':
      return 'quota'
    case 'aborted':
      return 'aborted'
  }
}

export class OpencodeNativeBackend implements AgentBackend {
  constructor(
    private readonly dependencies: OpencodeNativeBackendDependencies,
  ) {}

  async run(request: PhaseInvocationRequest): Promise<PhaseRunResult> {
    if (agentForRole(request.config, request.role) !== 'opencode') {
      return this.dependencies.fallback.run(request)
    }

    let childID: string
    try {
      const created = dataOrThrow(
        await this.dependencies.client.session.create({
          body: {
            parentID: this.dependencies.parentSessionID,
            title: request.title,
          },
          query: { directory: this.dependencies.directory },
        }),
      )
      childID = created.id
    } catch (error) {
      request.log(`  ! opencode 자식 세션 생성 실패: ${errorMessage(error)}`)
      return { kind: 'exit', code: 1 }
    }

    this.dependencies.controller.registerChild(childID, {
      directory: this.dependencies.directory,
      skipPermissions: request.config.skipPermissions,
    })
    request.log(
      `  ↳ opencode ${request.stage ?? request.phase} (${request.model || 'agent default'}, fresh native session)…`,
    )

    const timeoutMs =
      request.timeoutMs ??
      this.dependencies.defaultPhaseTimeoutMs ??
      DEFAULT_PHASE_TIMEOUT_MS
    const waiterAbort = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    let result: PhaseRunResult

    try {
      const model = parseModel(request.model)
      const prompt = this.dependencies.client.session
        .prompt({
          path: { id: childID },
          query: { directory: this.dependencies.directory },
          body: {
            ...(model === undefined ? {} : { model }),
            ...(request.config.agentProfile === ''
              ? {}
              : { agent: request.config.agentProfile }),
            parts: [{ type: 'text', text: request.message }],
          },
        })
        .then((response): PromptResult => ({
          kind: 'prompt',
          response: dataOrThrow(response),
        }))
      const event = this.dependencies.controller
        .waitForChild(childID, timeoutMs, waiterAbort.signal)
        .then((): IdleResult => ({ kind: 'idle' }))
      const deadline = new Promise<TimeoutResult>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
      })

      const first = await Promise.race([prompt, event, deadline])
      const completed =
        first.kind === 'idle' ? await Promise.race([prompt, deadline]) : first

      if (completed.kind === 'timeout') {
        result = (await this.abortChild(childID, request))
          ? { kind: 'exit', code: 1 }
          : { kind: 'aborted' }
      } else {
        const error = completed.response.info.error
        if (error === undefined) {
          result = { kind: 'exit', code: 0 }
        } else if (
          isMessageAbortedError(error) &&
          this.dependencies.controller.isLoopStopping(
            this.dependencies.directory,
          )
        ) {
          result = { kind: 'aborted' }
        } else {
          result =
            classifySdkError(error) === 'quota'
              ? { kind: 'quota' }
              : { kind: 'exit', code: 1 }
        }
      }
    } catch (error) {
      const sdkError =
        error instanceof ChildSessionError ? error.payload : error
      if (
        this.dependencies.controller.isLoopStopping(
          this.dependencies.directory,
        ) &&
        (isMessageAbortedError(sdkError) ||
          error instanceof ChildSessionWaitAbortedError)
      ) {
        result = { kind: 'aborted' }
      } else if (error instanceof ChildSessionTimeoutError) {
        result = (await this.abortChild(childID, request))
          ? { kind: 'exit', code: 1 }
          : { kind: 'aborted' }
      } else if (classifySdkError(sdkError) === 'quota') {
        result = { kind: 'quota' }
      } else {
        request.log(`  ! opencode 네이티브 세션 실패: ${errorMessage(error)}`)
        result = { kind: 'exit', code: 1 }
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
      waiterAbort.abort()
      // Stop permission auto-replies after bounded cleanup, even if the child became orphaned.
      this.dependencies.controller.unregisterChild(childID)
    }

    await this.appendResult(request, childID, result)
    return result
  }

  private async abortChild(
    childID: string,
    request: PhaseInvocationRequest,
  ): Promise<boolean> {
    const abortTimeoutMs = this.dependencies.abortTimeoutMs ?? ABORT_TIMEOUT_MS
    let timeout: ReturnType<typeof setTimeout> | undefined
    const logFailure = (detail: string): void => {
      request.log(
        `  ! 제한 시간 초과 후 세션 중단 실패: ${detail}. 자식 세션 중단을 확인할 수 없어 재시도하지 않고 단계를 강제 정지합니다. 자식 세션이 계속 실행 중일 수 있습니다.`,
      )
    }
    try {
      const completed = await Promise.race([
        this.dependencies.client.session
          .abort({
            path: { id: childID },
            query: { directory: this.dependencies.directory },
          })
          .then((response) => ({ kind: 'response', response }) as const),
        new Promise<{ readonly kind: 'timeout' }>((resolve) => {
          timeout = setTimeout(
            () => resolve({ kind: 'timeout' }),
            abortTimeoutMs,
          )
        }),
      ])
      if (completed.kind === 'timeout') {
        logFailure(`중단 요청이 ${abortTimeoutMs}ms 안에 완료되지 않음`)
        return false
      }
      if (completed.response.data !== true) {
        logFailure(
          completed.response.error === undefined
            ? '중단 요청이 거부됨'
            : errorMessage(completed.response.error),
        )
        return false
      }
      return true
    } catch (error) {
      logFailure(errorMessage(error))
      return false
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }

  private async appendResult(
    request: PhaseInvocationRequest,
    childID: string,
    result: PhaseRunResult,
  ): Promise<void> {
    try {
      await mkdir(dirname(request.logPath), { recursive: true })
      await appendFile(
        request.logPath,
        `[opencode native] child=${childID} result=${resultLabel(result)}\n`,
        'utf8',
      )
    } catch (error) {
      request.log(`  ! 네이티브 실행 로그 기록 실패: ${errorMessage(error)}`)
    }
  }
}

export function createOpencodeNativeBackend(
  dependencies: OpencodeNativeBackendDependencies,
): AgentBackend {
  return new OpencodeNativeBackend(dependencies)
}
