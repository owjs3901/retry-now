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
import { ChildSessionError, type LoopController } from './controller.ts'
import { parseModel } from './model.ts'
import { classifySdkError } from './sdk-error.ts'

const DEFAULT_PHASE_TIMEOUT_MS = 30 * 60 * 1_000
const ABORT_TIMEOUT_MS = 10_000
/** How often the native backend re-reads the agent's signal file while a phase runs. */
const SIGNAL_POLL_MS = 300
/** Grace after a `session.error` / deadline for a just-started terminal-signal write to land. */
const SIGNAL_SETTLE_MS = 250

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isMessageAbortedError(value: unknown): boolean {
  return isRecord(value) && value.name === 'MessageAbortedError'
}

/**
 * Human-readable rendering of any thrown/returned error. opencode SDK errors are plain records
 * shaped like `{ name, data: { message } }`, so a bare `String(err)` yields a useless
 * `[object Object]`; pull out `name` + `data.message` (falling back to JSON) so a failed native
 * phase logs WHY it failed, not a black box.
 */
function describeError(value: unknown): string {
  if (value instanceof Error) return value.message
  if (isRecord(value)) {
    const name = typeof value.name === 'string' ? value.name : undefined
    const data = value.data
    const message =
      isRecord(data) && typeof data.message === 'string'
        ? data.message
        : typeof value.message === 'string'
          ? value.message
          : undefined
    if (message !== undefined) return name ? `${name}: ${message}` : message
    if (name !== undefined) return name
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

function errorMessage(error: unknown): string {
  if (error instanceof NativeClientCallError) return describeError(error.detail)
  return describeError(error)
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
      title: request.title,
    })
    request.log(
      `  ↳ opencode ${request.stage ?? request.phase} (${request.model || 'agent default'}, fresh native session)…`,
    )

    const timeoutMs =
      request.timeoutMs ??
      this.dependencies.defaultPhaseTimeoutMs ??
      DEFAULT_PHASE_TIMEOUT_MS

    // A valid terminal `signal.json` (any result != pending, matching iteration+phase) is the ONLY
    // proof a phase finished. `session.idle` fires on EVERY turn boundary — and the child itself
    // fans out background sub-agents and goes idle WHILE they run — so a first idle is not "done".
    // `session.prompt`'s HTTP await, meanwhile, can reject at undici's 5-minute headers timeout
    // long before a long turn ends. So completion is gated on the file the child writes; idle,
    // errors, the prompt settlement, and the deadline are only fast re-check / failure triggers.
    const probe = request.completionProbe
    let settled = false
    // Captured on a failure path so the reason lands in BOTH the terminal (request.log) and the
    // phase log file — a native session error is otherwise invisible (its detail lives only in the
    // child's opencode session, not this log).
    let failureDetail: string | undefined
    const done = Promise.withResolvers<PhaseRunResult>()
    const finish = (value: PhaseRunResult): void => {
      if (settled) return
      settled = true
      done.resolve(value)
    }
    const hasSignal = async (): Promise<boolean> => {
      if (probe === undefined) return false
      try {
        return (await probe()) !== null
      } catch {
        return false
      }
    }
    const succeedIfSignal = (): void => {
      void hasSignal().then((ok) => {
        if (ok) finish({ kind: 'exit', code: 0 })
      })
    }
    // CONTAINING: a non-success outcome must never leave the child running, or a retry would
    // overlap two children writing the same signal path. Abort and confirm before returning a
    // retryable result; if containment can't be confirmed, downgrade to `aborted` — which
    // `runPhaseResilient` refuses to retry — rather than risk an orphan mutating the repo.
    const contain = async (
      onContained: PhaseRunResult,
    ): Promise<PhaseRunResult> =>
      (await this.abortChild(childID, request))
        ? onContained
        : { kind: 'aborted' }
    // ERROR / TIMEOUT arbitration: a child can emit a benign `session.error` (or hit the deadline)
    // just AFTER writing its signal — prefer completed work, re-probing once after a short
    // write-settle window before classifying a failure.
    const fail = async (rawError: unknown): Promise<void> => {
      if (settled) return
      if (await hasSignal()) {
        finish({ kind: 'exit', code: 0 })
        return
      }
      await delay(SIGNAL_SETTLE_MS)
      if (await hasSignal()) {
        finish({ kind: 'exit', code: 0 })
        return
      }
      const sdkError =
        rawError instanceof ChildSessionError ? rawError.payload : rawError
      if (
        this.dependencies.controller.isLoopStopping(
          this.dependencies.directory,
        ) &&
        isMessageAbortedError(sdkError)
      ) {
        finish({ kind: 'aborted' })
        return
      }
      const detail = errorMessage(sdkError)
      failureDetail = detail
      request.log(`  ! opencode 세션 실패(신호 미기록): ${detail}`)
      finish(
        await contain(
          classifySdkError(sdkError) === 'quota'
            ? { kind: 'quota' }
            : { kind: 'exit', code: 1 },
        ),
      )
    }

    const unsubscribe = this.dependencies.controller.monitorChild(childID, {
      onIdle: () => {
        // A missing probe (non-native callers) keeps the legacy first-idle completion; a native
        // phase re-checks the signal and keeps waiting through intermediate idles.
        if (probe === undefined) finish({ kind: 'exit', code: 0 })
        else succeedIfSignal()
      },
      onError: (error) => {
        void fail(error)
      },
    })

    const model = parseModel(request.model)
    const prompt = this.dependencies.client.session
      .prompt({
        path: { id: childID },
        query: { directory: this.dependencies.directory },
        body: {
          ...(model === undefined ? {} : { model }),
          // Context-zero requires a CLEAN agent. An empty agentProfile must NOT fall through to
          // opencode's default agent: under a curated setup (e.g. oh-my-openagent) that default is a
          // heavyweight primary agent that injects its own persona/skills, overrides the configured
          // model, and fans out background sub-agents (a known opencode REST-path hang, #6573). Pin
          // the plain built-in `build` agent so each reincarnation is a clean, model-honoring session.
          agent:
            request.config.agentProfile === ''
              ? 'build'
              : request.config.agentProfile,
          parts: [{ type: 'text', text: request.message }],
        },
      })
      .then((response): NativePromptResponse => dataOrThrow(response))
    // The prompt promise is attached but NOT authoritative: a clean turn end just re-probes; a
    // resolved `info.error` goes to arbitration; a rejection (undici headers timeout or an abort)
    // is swallowed — the signal poll / deadline own completion.
    prompt.then(
      (response) => {
        if (settled) return
        const error = response.info.error
        if (error === undefined) {
          if (probe === undefined) finish({ kind: 'exit', code: 0 })
          else succeedIfSignal()
        } else {
          void fail(error)
        }
      },
      () => undefined,
    )

    // Primary success detector: poll the signal file until the child writes its terminal result,
    // surviving any number of intermediate idles while its background sub-agents run.
    const poll =
      probe === undefined
        ? undefined
        : setInterval(succeedIfSignal, SIGNAL_POLL_MS)
    // Absolute deadline: one last probe (a signal/deadline tie favors completed work) before
    // aborting + failing.
    const timeout = setTimeout(() => {
      void (async () => {
        if (settled) return
        if (await hasSignal()) {
          finish({ kind: 'exit', code: 0 })
          return
        }
        failureDetail = `phase deadline ${timeoutMs}ms exceeded with no signal`
        request.log(
          `  ! opencode 세션 제한 시간 ${timeoutMs}ms 초과 — 신호 미기록`,
        )
        finish(await contain({ kind: 'exit', code: 1 }))
      })()
    }, timeoutMs)

    let result: PhaseRunResult
    try {
      result = await done.promise
    } finally {
      clearTimeout(timeout)
      if (poll !== undefined) clearInterval(poll)
      unsubscribe()
      // Swallow the possibly-still-pending prompt promise and stop permission auto-replies.
      void prompt.catch(() => undefined)
      this.dependencies.controller.unregisterChild(childID)
    }

    await this.appendResult(request, childID, result, failureDetail)
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
    detail?: string,
  ): Promise<void> {
    try {
      await mkdir(dirname(request.logPath), { recursive: true })
      const suffix = detail !== undefined && detail !== '' ? ` — ${detail}` : ''
      await appendFile(
        request.logPath,
        `[opencode native] child=${childID} result=${resultLabel(result)}${suffix}\n`,
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
