import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { type DriverResult, resolvePaths, slugifyTarget } from '@retry-now/core'
import { expect, test } from 'bun:test'

import { createRetryNowTools } from '../tools.ts'
import { seedConfig, seedState, withFixture } from './tools-fixture.ts'

test('start guides the setup interview when config is missing without registering a loop', async () => {
  await withFixture(async ({ root, controller, runtime, calls }) => {
    // Given
    const context = { directory: root, sessionID: 'parent-1' }

    // When
    const output = await runtime.start({}, context)

    // Then
    expect(output).toContain('설정이 없다')
    expect(output).toContain('/retry-now')
    expect(controller.getLoopStatus(root)).toBeUndefined()
    expect(calls).toHaveLength(0)
  })
})

test('registers all three opencode custom tool definitions', async () => {
  await withFixture(async ({ runtime }) => {
    // Given / When
    const tools = createRetryNowTools(runtime)

    // Then
    expect(Object.keys(tools).sort()).toEqual([
      'retrynow_start',
      'retrynow_status',
      'retrynow_stop',
    ])
  })
})

test('executes the status tool through the opencode tool surface', async () => {
  await withFixture(async ({ root, runtime }) => {
    // Given
    const statusTool = createRetryNowTools(runtime).retrynow_status
    if (statusTool === undefined)
      throw new Error('status tool was not registered')

    // When
    const output = await statusTool.execute(
      {},
      {
        sessionID: 'parent-1',
        messageID: 'message-1',
        agent: 'build',
        directory: root,
        worktree: root,
        abort: new AbortController().signal,
        metadata: () => undefined,
        ask: async () => undefined,
      },
    )

    // Then
    expect(output).toBe(
      '설정이 없다. 먼저 `/retry-now` 커맨드의 설정 인터뷰를 진행하라.',
    )
  })
})

test('start registers one detached loop and records its terminal result', async () => {
  await withFixture(
    async ({ root, controller, runtime, calls, setRunResult }) => {
      // Given
      await seedConfig(root)
      let resolveRun: ((result: DriverResult) => void) | undefined
      setRunResult(
        new Promise<DriverResult>((resolve) => {
          resolveRun = resolve
        }),
      )
      const context = { directory: root, sessionID: 'parent-1' }

      // When
      const started = await runtime.start({ dryRun: true }, context)
      const duplicate = await runtime.start({}, context)

      // Then
      expect(started).toContain('retry-now #NNNN')
      expect(duplicate).toContain('이미')
      expect(controller.getLoopStatus(root)).toBe('running')
      expect(calls).toHaveLength(1)
      expect(calls[0]?.dryRun).toBe(true)
      resolveRun?.({
        status: 'stopped-converged',
        iterations: 2,
        finalStreak: 5,
        threshold: 5,
      })
      await runtime.waitForCompletion(root)
      expect(controller.getLoopStatus(root)).toBeUndefined()
      expect(await runtime.status(context)).toContain('stopped-converged')
    },
  )
})

test('status shows a running whole-repo state and interrupted-loop guidance', async () => {
  await withFixture(async ({ root, runtime }) => {
    // Given
    await seedConfig(root)
    await seedState(resolvePaths(root).state, 'running', 7, 2)

    // When
    const output = await runtime.status({
      directory: root,
      sessionID: 'parent-1',
    })

    // Then
    expect(output).toContain('전체 레포 단일 윤회')
    expect(output).toContain('running  iter=7  streak=2/5')
    expect(output).toContain('중단된 것으로 보입니다')
    expect(output).toContain('retrynow_start')
  })
})

test('detached failures are logged and reflected in status without leaking a rejection', async () => {
  await withFixture(async ({ root, runtime, setRunResult }) => {
    // Given
    await seedConfig(root)
    let rejectRun: ((error: Error) => void) | undefined
    setRunResult(
      new Promise<DriverResult>((_resolve, reject) => {
        rejectRun = reject
      }),
    )
    const context = { directory: root, sessionID: 'parent-1' }

    // When
    await runtime.start({}, context)
    rejectRun?.(new Error('native loop exploded'))
    await runtime.waitForCompletion(root)

    // Then
    expect(await runtime.status(context)).toContain(
      'error — native loop exploded',
    )
    expect(
      await readFile(join(resolvePaths(root).logsDir, 'plugin.log'), 'utf8'),
    ).toContain('native loop exploded')
  })
})

test('status shows converged state and streak for each split target', async () => {
  await withFixture(async ({ root, runtime }) => {
    // Given
    const targets = ['packages/a', 'packages/b'] as const
    await seedConfig(root, targets)
    for (const target of targets) {
      await seedState(
        resolvePaths(root, slugifyTarget(target)).state,
        'stopped-converged',
        9,
        5,
      )
    }

    // When
    const output = await runtime.status({
      directory: root,
      sessionID: 'parent-1',
    })

    // Then
    expect(output).toContain('패키지별 분할 (2 타겟)')
    expect(output).toContain(
      'packages/a: stopped-converged  iter=9  streak=5/5',
    )
    expect(output).toContain(
      'packages/b: stopped-converged  iter=9  streak=5/5',
    )
    expect(output).not.toContain('중단된 것으로 보입니다')
  })
})

test('stop writes the sentinel, marks stopping, and aborts the active child', async () => {
  await withFixture(async ({ root, client, controller, runtime }) => {
    // Given
    controller.registerLoop(root)
    controller.registerChild('child-1', {
      directory: root,
      skipPermissions: true,
    })
    const otherDirectory = `${root}-other`
    controller.registerChild('child-2', {
      directory: otherDirectory,
      skipPermissions: true,
    })
    const waiterAbort = new AbortController()
    const otherWaiter = controller.waitForChild(
      'child-2',
      1_000,
      waiterAbort.signal,
    )

    // When
    const output = await runtime.stop({
      directory: root,
      sessionID: 'parent-1',
    })

    // Then
    expect(await Bun.file(resolvePaths(root).stop).exists()).toBe(true)
    expect(controller.getLoopStatus(root)).toBe('stopping')
    expect(client.abortCalls).toEqual([
      { path: { id: 'child-1' }, query: { directory: root } },
    ])
    controller.handleEvent({
      type: 'session.idle',
      properties: { sessionID: 'child-2' },
    })
    await expect(otherWaiter).resolves.toBeUndefined()
    expect(output).toContain('다음 경계에서 정지')
    expect(output).toContain('즉시 중단')
  })
})
