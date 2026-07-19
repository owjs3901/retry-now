import type { NativeClientResult, NativeSessionClient } from './client.ts'

export class ChildSessionError extends Error {
  override readonly name = 'ChildSessionError'

  constructor(
    readonly sessionID: string,
    readonly payload: unknown,
  ) {
    super(`child session failed: ${sessionID}`)
  }
}

export class ChildSessionTimeoutError extends Error {
  override readonly name = 'ChildSessionTimeoutError'

  constructor(readonly sessionID: string) {
    super(`child session timed out: ${sessionID}`)
  }
}

export class ChildSessionWaitAbortedError extends Error {
  override readonly name = 'ChildSessionWaitAbortedError'

  constructor(readonly sessionID: string) {
    super(`child session wait aborted: ${sessionID}`)
  }
}

export interface ManagedChildOptions {
  readonly directory: string
  readonly skipPermissions: boolean
}

export type LoopActivity = 'running' | 'stopping'

interface ManagedChild extends ManagedChildOptions {
  readonly repliedPermissions: Set<string>
}

interface ChildWaiter {
  readonly resolve: () => void
  readonly reject: (error: Error) => void
}

type ControllerLogger = (line: string) => void

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function resultError(result: NativeClientResult<unknown>): unknown | undefined {
  return result.error
}

export class LoopController {
  private readonly children = new Map<string, ManagedChild>()
  private readonly waiters = new Map<string, Set<ChildWaiter>>()
  private readonly loops = new Map<string, LoopActivity>()

  constructor(
    private readonly client: NativeSessionClient,
    private readonly log: ControllerLogger = (line) => console.error(line),
  ) {}

  registerChild(sessionID: string, options: ManagedChildOptions): void {
    this.children.set(sessionID, {
      ...options,
      repliedPermissions: new Set<string>(),
    })
  }

  unregisterChild(sessionID: string): void {
    this.children.delete(sessionID)
  }

  handleEvent(event: unknown): void {
    if (!isRecord(event) || typeof event.type !== 'string') return
    if (!isRecord(event.properties)) return
    const properties = event.properties

    if (
      event.type === 'permission.updated' ||
      event.type === 'permission.asked'
    ) {
      this.handlePermission(properties)
      return
    }

    if (event.type === 'session.idle') {
      if (typeof properties.sessionID === 'string') {
        this.resolveChild(properties.sessionID)
      }
      return
    }

    if (event.type === 'session.status') {
      if (
        typeof properties.sessionID === 'string' &&
        isRecord(properties.status) &&
        properties.status.type === 'idle'
      ) {
        this.resolveChild(properties.sessionID)
      }
      return
    }

    if (
      event.type === 'session.error' &&
      typeof properties.sessionID === 'string'
    ) {
      this.rejectChild(
        properties.sessionID,
        new ChildSessionError(properties.sessionID, properties.error),
      )
    }
  }

  waitForChild(
    sessionID: string,
    timeoutMs: number,
    abortSignal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiters = this.waiters.get(sessionID) ?? new Set<ChildWaiter>()
      let settled = false
      let timer: ReturnType<typeof setTimeout>
      let waiter: ChildWaiter
      const cleanup = (): void => {
        clearTimeout(timer)
        abortSignal.removeEventListener('abort', onAbort)
        waiters.delete(waiter)
        if (waiters.size === 0) this.waiters.delete(sessionID)
      }
      const finishResolve = (): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve()
      }
      const finishReject = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const onAbort = (): void => {
        finishReject(new ChildSessionWaitAbortedError(sessionID))
      }

      waiter = { resolve: finishResolve, reject: finishReject }
      timer = setTimeout(
        () => finishReject(new ChildSessionTimeoutError(sessionID)),
        timeoutMs,
      )
      waiters.add(waiter)
      this.waiters.set(sessionID, waiters)
      abortSignal.addEventListener('abort', onAbort, { once: true })
      if (abortSignal.aborted) onAbort()
    })
  }

  async abortActive(directory: string): Promise<void> {
    await Promise.all(
      [...this.children]
        .filter(([, child]) => child.directory === directory)
        .map(async ([sessionID, child]) => {
          try {
            const result = await this.client.session.abort({
              path: { id: sessionID },
              query: { directory: child.directory },
            })
            const error = resultError(result)
            if (error !== undefined) {
              this.log(
                `  ! 자식 세션 중단 실패 (${sessionID}): ${errorMessage(error)}`,
              )
            }
          } catch (error) {
            this.log(
              `  ! 자식 세션 중단 실패 (${sessionID}): ${errorMessage(error)}`,
            )
          }
        }),
    )
  }

  registerLoop(directory: string): boolean {
    if (this.loops.has(directory)) return false
    this.loops.set(directory, 'running')
    return true
  }

  unregisterLoop(directory: string): void {
    this.loops.delete(directory)
  }

  markLoopStopping(directory: string): void {
    if (this.loops.has(directory)) this.loops.set(directory, 'stopping')
  }

  getLoopStatus(directory: string): LoopActivity | undefined {
    return this.loops.get(directory)
  }

  isLoopStopping(directory: string): boolean {
    return this.loops.get(directory) === 'stopping'
  }

  private handlePermission(properties: Record<string, unknown>): void {
    if (
      typeof properties.id !== 'string' ||
      typeof properties.sessionID !== 'string'
    ) {
      return
    }
    const child = this.children.get(properties.sessionID)
    if (
      child === undefined ||
      !child.skipPermissions ||
      child.repliedPermissions.has(properties.id)
    ) {
      return
    }
    child.repliedPermissions.add(properties.id)
    void this.replyPermission(
      properties.sessionID,
      properties.id,
      child.directory,
    )
  }

  private async replyPermission(
    sessionID: string,
    permissionID: string,
    directory: string,
  ): Promise<void> {
    try {
      const result = await this.client.postSessionIdPermissionsPermissionId({
        path: { id: sessionID, permissionID },
        query: { directory },
        body: { response: 'once' },
      })
      const error = resultError(result)
      if (error !== undefined) {
        this.log(
          `  ! 권한 자동 승인 실패 (${sessionID}/${permissionID}): ${errorMessage(error)}`,
        )
      }
    } catch (error) {
      this.log(
        `  ! 권한 자동 승인 실패 (${sessionID}/${permissionID}): ${errorMessage(error)}`,
      )
    }
  }

  private resolveChild(sessionID: string): void {
    if (!this.children.has(sessionID)) return
    const waiters = this.waiters.get(sessionID)
    if (waiters === undefined) return
    this.waiters.delete(sessionID)
    for (const waiter of waiters) waiter.resolve()
  }

  private rejectChild(sessionID: string, error: Error): void {
    if (!this.children.has(sessionID)) return
    const waiters = this.waiters.get(sessionID)
    if (waiters === undefined) return
    this.waiters.delete(sessionID)
    for (const waiter of waiters) waiter.reject(error)
  }
}
