import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { type DriverResult, resolvePaths, slugifyTarget } from '@retry-now/core'
import { expect, test } from 'bun:test'

import { createRetryNowTools } from '../tools.ts'
import { seedConfig, seedState, withFixture } from './tools-fixture.ts'

function toolContext(directory: string) {
  return {
    sessionID: 'parent-1',
    messageID: 'message-1',
    agent: 'build',
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask: async () => undefined,
  }
}

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

test('registers every opencode custom tool definition', async () => {
  await withFixture(async ({ runtime }) => {
    // Given / When
    const tools = createRetryNowTools(runtime)

    // Then
    expect(Object.keys(tools).sort()).toEqual([
      // `recover` is a TOOL and not only a CLI command because in plugin mode the driver lives inside
      // the opencode process, so the restart that kills it is the ordinary way this is used.
      'retrynow_recover',
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
      const startTool = createRetryNowTools(runtime).retrynow_start
      if (startTool === undefined)
        throw new Error('start tool was not registered')
      const started = await startTool.execute(
        { dryRun: true },
        toolContext(root),
      )
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
    expect(output).toContain('비정상 종료된 것으로 보입니다')
    // No `iteration.json`, so there is no interrupted batch and restarting is safe to suggest.
    expect(output).toContain('복구할 중단된 배치는 없습니다')
    expect(output).toContain('retrynow_start')
  })
})

test('status demands recovery BEFORE restart when a batch was left in flight', async () => {
  await withFixture(async ({ root, runtime }) => {
    // Given a killed driver that left an in-flight IMPROVE transaction behind.
    await seedConfig(root)
    const paths = resolvePaths(root)
    await seedState(paths.state, 'running', 44, 0)
    await writeFile(
      paths.iterationRecord,
      JSON.stringify({
        iteration: 45,
        baselineHead: 'a'.repeat(40),
        plannedCount: 5,
        scope: '',
        startedAt: '2026-07-30T00:00:00.000Z',
      }),
      'utf8',
    )

    // When
    const output = await runtime.status({
      directory: root,
      sessionID: 'parent-1',
    })

    // Then: restarting first is the destructive path, so recovery must be named first.
    expect(output).toContain('비정상 종료된 것으로 보입니다')
    expect(output).toContain('retrynow_recover')
    expect(output).toContain('영구히 사라집니다')
    expect(output).not.toContain('복구할 중단된 배치는 없습니다')
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

test('detached execution survives an unavailable plugin log path', async () => {
  await withFixture(async ({ root, runtime }) => {
    // Given a regular file where the driver needs its logs directory.
    await seedConfig(root)
    const paths = resolvePaths(root)
    await writeFile(paths.logsDir, 'occupied', 'utf8')
    const context = { directory: root, sessionID: 'parent-1' }

    // When
    await runtime.start({}, context)
    await runtime.waitForCompletion(root)

    // Then the loop result remains observable even though both mkdir and append fail.
    expect(await runtime.status(context)).toContain('stopped-converged')
    expect(await readFile(paths.logsDir, 'utf8')).toBe('occupied')
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
    const stopTool = createRetryNowTools(runtime).retrynow_stop
    if (stopTool === undefined) throw new Error('stop tool was not registered')
    const output = await stopTool.execute({}, toolContext(root))

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

test('status surfaces the live phase child sessions the driver registered', async () => {
  await withFixture(async ({ root, runtime, controller }) => {
    // Given: a driver has launched an ANALYZE phase child for this project
    await seedConfig(root)
    controller.registerChild('ses_child_a1', {
      directory: root,
      skipPermissions: true,
      title: 'retry-now #0001 ANALYZE',
    })

    // When
    const output = await runtime.status({
      directory: root,
      sessionID: 'parent-1',
    })

    // Then: the live sub-agent is surfaced with its title + session id (the task-panel stand-in)
    expect(output).toContain('sessions   : 1 live')
    expect(output).toContain('retry-now #0001 ANALYZE · ses_child_a1')
  })
})

test('recover tool reports the recovered prefix and points at restart', async () => {
  await withFixture(
    async ({ root, runtime, recoverCalls, setRecoverResult }) => {
      // Given a recovery that kept the reviewed prefix and rolled the unreviewed item back.
      setRecoverResult(
        [
          {
            status: 'recovered',
            target: null,
            iteration: 44,
            keptCount: 4,
            plannedCount: 5,
            rolledBack: ['5'],
            committed: true,
            reason: null,
            lines: ['◆ 전체 레포', '  ✓ 리뷰를 통과한 4/5건을 커밋했습니다.'],
          },
        ],
        0,
      )

      // When
      const recoverTool = createRetryNowTools(runtime).retrynow_recover
      if (recoverTool === undefined)
        throw new Error('recover tool was not registered')
      const output = await recoverTool.execute({}, toolContext(root))

      // Then
      expect(recoverCalls).toEqual([root])
      expect(output).toContain('리뷰를 통과한 4/5건')
      expect(output).toContain(
        '복구 완료: 리뷰 통과 4건 보존, 미리뷰 item 5 롤백',
      )
      expect(output).toContain('retrynow_start')
    },
  )
})

test('recover tool surfaces a refusal without claiming success', async () => {
  await withFixture(async ({ root, runtime, setRecoverResult }) => {
    // Given
    setRecoverResult(
      [
        {
          status: 'refused',
          target: null,
          iteration: 44,
          keptCount: 0,
          plannedCount: 0,
          rolledBack: [],
          committed: false,
          reason: '백업 디렉터리가 없습니다',
          lines: [
            '◆ 전체 레포',
            '  ✗ 복구를 거부했습니다 — 백업 디렉터리가 없습니다',
          ],
        },
      ],
      1,
    )

    // When
    const output = await runtime.recover({
      directory: root,
      sessionID: 'parent-1',
    })

    // Then
    expect(output).toContain('복구를 거부했습니다')
    expect(output).toContain('복구를 완료하지 못했습니다')
    expect(output).not.toContain('복구 완료:')
  })
})

test('recover tool REFUSES to touch state while a loop is active in this process', async () => {
  await withFixture(async ({ root, runtime, controller, recoverCalls }) => {
    // Given a live loop registered in this process
    expect(controller.registerLoop(root)).toBe(true)

    // When
    const output = await runtime.recover({
      directory: root,
      sessionID: 'parent-1',
    })

    // Then: never rewrite the state a running driver is using.
    expect(output).toContain('retrynow_stop')
    expect(recoverCalls).toEqual([])
  })
})
