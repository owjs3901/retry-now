import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PluginInput } from '@opencode-ai/plugin'
import type {
  AgentBackend,
  PhaseInvocationRequest,
  PhaseRunResult,
  RetryNowConfig,
  Signal,
} from '@retry-now/core'
import { expect, test } from 'bun:test'

import { createOpencodeNativeBackend } from '../backend.ts'
import type { NativeSessionClient } from '../client.ts'
import { LoopController } from '../controller.ts'
import { FakeNativeClient, success } from './fake-native-client.ts'

function narrowRealClient(client: PluginInput['client']): NativeSessionClient {
  return client
}

const directory = 'C:/workspace/project'

function config(overrides: Partial<RetryNowConfig> = {}): RetryNowConfig {
  return {
    version: 1,
    agent: 'opencode',
    analysisAgent: 'opencode',
    improveAgent: 'opencode',
    reviewAgent: 'opencode',
    model: '',
    analysisModel: '',
    improveModel: '',
    reviewModel: '',
    modelVariant: '',
    analysisVariant: '',
    improveVariant: '',
    reviewVariant: '',
    agentProfile: '',
    analysis: 'Analyze.',
    direction: 'Improve.',
    completion: 'Complete.',
    threshold: 3,
    revertThreshold: 3,
    maxIterations: 10,
    skipPermissions: true,
    commitPerIteration: false,
    verifyEnabled: false,
    verifyTest: '',
    verifyLint: '',
    benchCommand: '',
    benchRuns: 3,
    improvementBatchSize: 1,
    waitForQuota: false,
    quotaPollMs: 1_000,
    maxQuotaWaitMs: 10_000,
    targets: [],
    phaseTimeoutMs: 1_800_000,
    ...overrides,
  }
}

function request(
  logPath: string,
  overrides: Partial<PhaseInvocationRequest> = {},
): PhaseInvocationRequest {
  return {
    message: 'fresh phase instructions',
    role: 'analyze',
    title: 'retry-now #0001 ANALYZE',
    config: config(),
    logPath,
    cwd: directory,
    model: '',
    iteration: 1,
    phase: 'analyze',
    log: () => undefined,
    ...overrides,
  }
}

class FakeFallback implements AgentBackend {
  readonly calls: PhaseInvocationRequest[] = []
  result: PhaseRunResult = { kind: 'exit', code: 7 }

  async run(invocation: PhaseInvocationRequest): Promise<PhaseRunResult> {
    this.calls.push(invocation)
    return this.result
  }
}

async function withBackend(
  run: (fixture: {
    readonly client: FakeNativeClient
    readonly controller: LoopController
    readonly backend: AgentBackend
    readonly fallback: FakeFallback
    readonly logPath: string
  }) => Promise<void>,
  abortTimeoutMs?: number,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-native-'))
  const client = new FakeNativeClient()
  const controller = new LoopController(client)
  const fallback = new FakeFallback()
  const logPath = join(root, 'phase.log')
  const backend = createOpencodeNativeBackend({
    client,
    controller,
    parentSessionID: 'parent-1',
    directory,
    fallback,
    ...(abortTimeoutMs === undefined ? {} : { abortTimeoutMs }),
  })
  try {
    await run({ client, controller, backend, fallback, logPath })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('the public plugin client type is structurally assignable to the native seam', () => {
  expect(typeof narrowRealClient).toBe('function')
})

test('returns a retryable exit when child session creation returns an SDK error', async () => {
  await withBackend(async ({ client, backend, logPath }) => {
    // Given
    const lines: string[] = []
    client.createResult = {
      data: undefined,
      error: { name: 'ProviderError', data: { message: 'service offline' } },
    }

    // When
    const result = await backend.run(
      request(logPath, { log: (line) => lines.push(line) }),
    )

    // Then
    expect(result).toEqual({ kind: 'exit', code: 1 })
    expect(lines).toEqual([
      '  ! opencode 자식 세션 생성 실패: ProviderError: service offline',
    ])
    expect(client.promptCalls).toHaveLength(0)
  })
})

test('creates a context-zero child and prompts only that new session', async () => {
  await withBackend(async ({ client, backend, logPath }) => {
    // Given
    client.createResult = success({ id: 'fresh-child' })

    // When
    const result = await backend.run(request(logPath))

    // Then
    expect(result).toEqual({ kind: 'exit', code: 0 })
    expect(client.createCalls).toEqual([
      {
        body: {
          parentID: 'parent-1',
          title: 'retry-now #0001 ANALYZE',
        },
        query: { directory },
      },
    ])
    expect(client.promptCalls).toEqual([
      {
        path: { id: 'fresh-child' },
        query: { directory },
        body: {
          agent: 'build',
          parts: [{ type: 'text', text: 'fresh phase instructions' }],
        },
      },
    ])
    expect(await readFile(logPath, 'utf8')).toContain('fresh-child')
  })
})

test('maps a parseable model and agent profile into the prompt body', async () => {
  await withBackend(async ({ client, backend, logPath }) => {
    // Given
    const invocation = request(logPath, {
      model: 'openrouter/deepseek/deepseek-chat',
      config: config({ agentProfile: 'reviewer' }),
    })

    // When
    await backend.run(invocation)

    // Then
    expect(client.promptCalls[0]?.body).toEqual({
      model: {
        providerID: 'openrouter',
        modelID: 'deepseek/deepseek-chat',
      },
      agent: 'reviewer',
      parts: [{ type: 'text', text: 'fresh phase instructions' }],
    })
  })
})

test('omits an unparseable model but pins the clean build agent when no profile is set', async () => {
  await withBackend(async ({ client, backend, logPath }) => {
    // Given
    const invocation = request(logPath, {
      model: 'unparseable-model',
      config: config({ agentProfile: '' }),
    })

    // When
    await backend.run(invocation)

    // Then — an unparseable model is dropped, but an empty agentProfile pins `build` (never falls
    // through to the curated default agent) so the reincarnation stays context-zero.
    expect(client.promptCalls[0]?.body).toEqual({
      agent: 'build',
      parts: [{ type: 'text', text: 'fresh phase instructions' }],
    })
  })
})

test('returns quota for a prompt response carrying a 429 APIError', async () => {
  await withBackend(async ({ client, backend, logPath }) => {
    // Given
    client.promptImplementation = async () =>
      success({
        info: {
          error: {
            name: 'APIError',
            data: {
              message: 'Too Many Requests',
              statusCode: 429,
              isRetryable: true,
            },
          },
        },
        parts: [],
      })

    // When
    const result = await backend.run(request(logPath))

    // Then
    expect(result).toEqual({ kind: 'quota' })
  })
})

test('returns quota when a session.error event carries a 429 APIError before prompt resolves', async () => {
  await withBackend(async ({ client, controller, backend, logPath }) => {
    // Given
    let notifyPromptStarted: (() => void) | undefined
    const promptStarted = new Promise<void>((resolve) => {
      notifyPromptStarted = resolve
    })
    client.promptImplementation = () => {
      notifyPromptStarted?.()
      return new Promise(() => undefined)
    }
    const running = backend.run(request(logPath, { timeoutMs: 1_000 }))
    await promptStarted

    // When
    controller.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'child-1',
        error: {
          name: 'APIError',
          data: { message: 'Too Many Requests', statusCode: 429 },
        },
      },
    })
    const result = await running

    // Then
    expect(result).toEqual({ kind: 'quota' })
  })
})

test('returns a retryable exit when a session.error event carries a non-quota error', async () => {
  await withBackend(async ({ client, controller, backend, logPath }) => {
    // Given
    let notifyPromptStarted: (() => void) | undefined
    const promptStarted = new Promise<void>((resolve) => {
      notifyPromptStarted = resolve
    })
    client.promptImplementation = () => {
      notifyPromptStarted?.()
      return new Promise(() => undefined)
    }
    const running = backend.run(request(logPath, { timeoutMs: 1_000 }))
    await promptStarted

    // When
    controller.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'child-1',
        error: {
          name: 'UnknownError',
          data: { message: 'provider crashed' },
        },
      },
    })
    const result = await running

    // Then
    expect(result).toEqual({ kind: 'exit', code: 1 })
  })
})

test('aborts a hung child at the phase timeout and returns a retryable exit', async () => {
  await withBackend(async ({ client, backend, logPath }) => {
    // Given
    client.promptImplementation = () => new Promise(() => undefined)

    // When
    const result = await backend.run(request(logPath, { timeoutMs: 5 }))

    // Then
    expect(result).toEqual({ kind: 'exit', code: 1 })
    expect(client.abortCalls).toEqual([
      { path: { id: 'child-1' }, query: { directory } },
    ])
  })
})

test('a rejected prompt remains governed by the phase deadline and is contained', async () => {
  await withBackend(async ({ client, backend, logPath }) => {
    // Given an SDK transport rejection before any terminal signal exists.
    client.promptImplementation = async () => {
      throw new Error('headers timeout')
    }

    // When
    const result = await backend.run(request(logPath, { timeoutMs: 5 }))

    // Then the rejection itself does not escape, and the deadline aborts the child.
    expect(result).toEqual({ kind: 'exit', code: 1 })
    expect(client.abortCalls).toEqual([
      { path: { id: 'child-1' }, query: { directory } },
    ])
  })
})

test('returns aborted after a bounded abort attempt when the abort request never resolves', async () => {
  await withBackend(async ({ client, backend, logPath }) => {
    // Given
    const lines: string[] = []
    client.promptImplementation = () => new Promise(() => undefined)
    client.abortImplementation = () => new Promise(() => undefined)

    // When
    const result = await Promise.race([
      backend.run(
        request(logPath, { timeoutMs: 5, log: (line) => lines.push(line) }),
      ),
      Bun.sleep(100).then(() => 'hung' as const),
    ])

    // Then
    expect(result).toEqual({ kind: 'aborted' })
    expect(lines.some((line) => line.includes('강제 정지'))).toBe(true)
    expect(lines.some((line) => line.includes('계속 실행 중일 수'))).toBe(true)
  }, 5)
})

test('logs containment and returns aborted when abort returns false', async () => {
  await withBackend(async ({ client, backend, logPath }) => {
    // Given
    const lines: string[] = []
    client.promptImplementation = () => new Promise(() => undefined)
    client.abortImplementation = async () => success(false)

    // When
    const result = await backend.run(
      request(logPath, { timeoutMs: 5, log: (line) => lines.push(line) }),
    )

    // Then
    expect(result).toEqual({ kind: 'aborted' })
    expect(lines.some((line) => line.includes('강제 정지'))).toBe(true)
    expect(lines.some((line) => line.includes('계속 실행 중일 수'))).toBe(true)
  })
})

test('logs containment and returns aborted when abort throws', async () => {
  await withBackend(async ({ client, backend, logPath }) => {
    // Given
    const lines: string[] = []
    client.promptImplementation = () => new Promise(() => undefined)
    client.abortImplementation = async () => {
      throw new Error('abort failed')
    }

    // When
    const result = await backend.run(
      request(logPath, { timeoutMs: 5, log: (line) => lines.push(line) }),
    )

    // Then
    expect(result).toEqual({ kind: 'aborted' })
    expect(lines.some((line) => line.includes('강제 정지'))).toBe(true)
    expect(lines.some((line) => line.includes('계속 실행 중일 수'))).toBe(true)
  })
})

test('delegates a non-opencode role without creating a native session', async () => {
  await withBackend(async ({ client, backend, fallback, logPath }) => {
    // Given
    const invocation = request(logPath, {
      role: 'improve',
      config: config({ improveAgent: 'codex' }),
    })

    // When
    const result = await backend.run(invocation)

    // Then
    expect(result).toEqual({ kind: 'exit', code: 7 })
    expect(fallback.calls).toEqual([invocation])
    expect(client.createCalls).toHaveLength(0)
  })
})

test('maps an aborted prompt to aborted when the active loop is stopping', async () => {
  await withBackend(async ({ client, controller, backend, logPath }) => {
    // Given
    let finishPrompt: (() => void) | undefined
    let notifyPromptStarted: (() => void) | undefined
    const promptStarted = new Promise<void>((resolve) => {
      notifyPromptStarted = resolve
    })
    client.promptImplementation = () =>
      new Promise((resolve) => {
        notifyPromptStarted?.()
        finishPrompt = () => {
          resolve(
            success({
              info: {
                error: {
                  name: 'MessageAbortedError',
                  data: { message: 'Message aborted' },
                },
              },
              parts: [],
            }),
          )
        }
      })
    client.abortImplementation = async () => {
      finishPrompt?.()
      return success(true)
    }
    controller.registerLoop(directory)
    const running = backend.run(request(logPath, { timeoutMs: 1_000 }))
    await promptStarted

    // When
    controller.markLoopStopping(directory)
    await controller.abortActive(directory)
    const result = await running

    // Then
    expect(result).toEqual({ kind: 'aborted' })
    expect(client.abortCalls).toHaveLength(1)
  })
})

function terminalSignal(): Signal {
  return {
    iteration: 1,
    phase: 'analyze',
    result: 'improvements_found',
    report: '.retry-now/reports/0001-analyze.md',
    summary: '',
    timestamp: '2026-07-20T00:00:00.000Z',
  }
}

test('an intermediate idle while sub-agents run does not complete the phase; the signal does', async () => {
  await withBackend(async ({ client, controller, backend, logPath }) => {
    // Given: the prompt never settles (models the undici hang) and no signal is written yet.
    let signalReady = false
    client.promptImplementation = () => new Promise(() => undefined)
    const running = backend.run(
      request(logPath, {
        timeoutMs: 5_000,
        completionProbe: async () => (signalReady ? terminalSignal() : null),
      }),
    )
    await Bun.sleep(20)

    // When: the child goes idle while its own background sub-agents are still running — the OLD
    // backend completed here prematurely, before the signal was written.
    controller.handleEvent({
      type: 'session.idle',
      properties: { sessionID: 'child-1' },
    })

    // Then: still running — an intermediate idle must NOT complete the phase.
    const early = await Promise.race([
      running.then((value) => ({ done: true, value }) as const),
      Bun.sleep(150).then(() => ({ done: false }) as const),
    ])
    expect(early.done).toBe(false)

    // When: the child finishes its next turn, writes the terminal signal, and goes idle again.
    signalReady = true
    controller.handleEvent({
      type: 'session.idle',
      properties: { sessionID: 'child-1' },
    })

    // Then: only now does the phase complete.
    expect(await running).toEqual({ kind: 'exit', code: 0 })
  })
})

test('the signal poll latches success without any idle or prompt settlement', async () => {
  await withBackend(async ({ client, backend, logPath }) => {
    // Given: the prompt hangs and no lifecycle event ever fires — only the file appears.
    let signalReady = false
    client.promptImplementation = () => new Promise(() => undefined)
    const running = backend.run(
      request(logPath, {
        timeoutMs: 5_000,
        completionProbe: async () => (signalReady ? terminalSignal() : null),
      }),
    )
    await Bun.sleep(20)
    signalReady = true

    // Then: the periodic signal poll picks it up on its own.
    expect(await running).toEqual({ kind: 'exit', code: 0 })
  })
})

test('a terminal signal already written wins over a later benign session.error', async () => {
  await withBackend(async ({ client, controller, backend, logPath }) => {
    // Given: the signal is already present when an error arrives.
    client.promptImplementation = () => new Promise(() => undefined)
    const running = backend.run(
      request(logPath, {
        timeoutMs: 5_000,
        completionProbe: async () => terminalSignal(),
      }),
    )
    await Bun.sleep(20)

    // When: a session.error arrives after the work is already done.
    controller.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'child-1',
        error: { name: 'UnknownError', data: { message: 'benign late error' } },
      },
    })

    // Then: success — completed work is preferred, and the child is not aborted.
    expect(await running).toEqual({ kind: 'exit', code: 0 })
    expect(client.abortCalls).toHaveLength(0)
  })
})

test('a signal present at the deadline wins over a timeout failure', async () => {
  await withBackend(async ({ client, backend, logPath }) => {
    // Given: the prompt hangs, the deadline is shorter than one poll interval, and the signal is
    // already written.
    client.promptImplementation = () => new Promise(() => undefined)
    const running = backend.run(
      request(logPath, {
        timeoutMs: 60,
        completionProbe: async () => terminalSignal(),
      }),
    )

    // Then: the deadline's final probe sees the signal → success, no abort.
    expect(await running).toEqual({ kind: 'exit', code: 0 })
    expect(client.abortCalls).toHaveLength(0)
  })
})

test('a hard error with no signal and a failed abort returns aborted (non-retryable containment)', async () => {
  await withBackend(async ({ client, controller, backend, logPath }) => {
    // Given: no signal is ever written, the prompt hangs, and abort cannot be confirmed.
    client.promptImplementation = () => new Promise(() => undefined)
    client.abortImplementation = async () => success(false)
    const running = backend.run(
      request(logPath, {
        timeoutMs: 5_000,
        completionProbe: async () => null,
      }),
    )
    await Bun.sleep(20)

    // When: a non-quota session.error arrives and containment cannot be confirmed.
    controller.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'child-1',
        error: { name: 'UnknownError', data: { message: 'provider crashed' } },
      },
    })

    // Then: aborted — runPhaseResilient must NOT retry over a possibly-live child.
    expect(await running).toEqual({ kind: 'aborted' })
  })
})

test('a failed native session records the human-readable error reason in the phase log', async () => {
  await withBackend(async ({ client, controller, backend, logPath }) => {
    // Given: the prompt hangs and a non-quota session.error arrives shaped like an opencode SDK
    // error record ({ name, data: { message } }) — the exact shape a bare String() mangles.
    client.promptImplementation = () => new Promise(() => undefined)
    const running = backend.run(request(logPath, { timeoutMs: 1_000 }))
    await Bun.sleep(20)

    // When
    controller.handleEvent({
      type: 'session.error',
      properties: {
        sessionID: 'child-1',
        error: {
          name: 'ProviderError',
          data: { message: 'model unavailable' },
        },
      },
    })
    await running

    // Then: the phase log carries WHY it failed, not an opaque `[object Object]`.
    const log = await readFile(logPath, 'utf8')
    expect(log).toContain('ProviderError: model unavailable')
    expect(log).not.toContain('[object Object]')
  })
})
