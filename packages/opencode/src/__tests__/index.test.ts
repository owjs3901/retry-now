import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  buildPluginCommandFile,
  buildPluginRecoverCommandFile,
  buildPluginStatusCommandFile,
  buildPluginStopCommandFile,
  type DriverOptions,
} from '@retry-now/core'
import { expect, test } from 'bun:test'

import {
  createRetryNowPlugin,
  ensureCommandFile,
  type RetryNowPlugin,
} from '../index.ts'

const commandFiles = [
  buildPluginCommandFile(),
  buildPluginStatusCommandFile(),
  buildPluginStopCommandFile(),
  buildPluginRecoverCommandFile(),
] as const

async function seedConfig(root: string): Promise<void> {
  const path = join(root, '.retry-now', 'config.json')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    `${JSON.stringify({
      version: 1,
      agent: 'opencode',
      analysis: 'analyze',
      direction: 'improve',
      completion: 'complete',
      threshold: 5,
      revertThreshold: 3,
      commitPerIteration: false,
      targets: [],
    })}\n`,
    'utf8',
  )
}

function fakeClient(resolveDirectory: (sessionID: string) => string) {
  const getCalls: string[] = []
  return {
    getCalls,
    session: {
      get: async (options: { readonly path: { readonly id: string } }) => {
        getCalls.push(options.path.id)
        return { data: { directory: resolveDirectory(options.path.id) } }
      },
      create: async () => ({ data: { id: 'child-1' }, error: undefined }),
      prompt: async () => ({
        data: { info: {}, parts: [] },
        error: undefined,
      }),
      abort: async () => ({ data: true, error: undefined }),
    },
    postSessionIdPermissionsPermissionId: async () => ({
      data: true,
      error: undefined,
    }),
  }
}

async function loadHooks(
  plugin: typeof RetryNowPlugin,
  client: ReturnType<typeof fakeClient>,
  directory: string,
) {
  const hooks: unknown = await Reflect.apply(plugin, undefined, [
    { client, directory },
  ])
  if (typeof hooks !== 'object' || hooks === null)
    throw new Error('plugin did not return hooks')
  const eventHook = Reflect.get(hooks, 'event')
  const tools = Reflect.get(hooks, 'tool')
  if (typeof eventHook !== 'function')
    throw new Error('plugin did not return an event hook')
  if (typeof tools !== 'object' || tools === null)
    throw new Error('plugin did not return tools')
  return {
    event: (event: unknown): Promise<unknown> =>
      Promise.resolve(Reflect.apply(eventHook, hooks, [{ event }])),
    toolNames: Object.keys(tools).sort(),
  }
}

test('writes all four command files and leaves equal content untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-index-'))
  try {
    // Given / When
    ensureCommandFile(root)

    // Then
    for (const file of commandFiles) {
      expect(await readFile(join(root, file.homePath), 'utf8')).toBe(
        file.content,
      )
    }

    const unchangedPath = join(root, commandFiles[0].homePath)
    const oldTime = new Date('2000-01-01T00:00:00.000Z')
    await utimes(unchangedPath, oldTime, oldTime)
    const before = await stat(unchangedPath)
    ensureCommandFile(root)
    const after = await stat(unchangedPath)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('contains and reports a genuine command-file write failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-index-error-'))
  const errors: string[] = []
  const { spyOn } = await import('bun:test')
  const errorSpy = spyOn(console, 'error').mockImplementation((message) => {
    errors.push(String(message))
  })
  try {
    // Given
    const blockedHome = join(root, 'home-file')
    await writeFile(blockedHome, 'not a directory', 'utf8')

    // When
    ensureCommandFile(blockedHome)

    // Then
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('retry-now command registration failed:')
    expect(errors[0]).toContain('home-file')
  } finally {
    errorSpy.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})

test('starts from the command session directory and exposes every tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-plugin-'))
  try {
    // Given
    const sessionRoot = join(root, 'session-project')
    await seedConfig(sessionRoot)
    const client = fakeClient(() => sessionRoot)
    const calls: DriverOptions[] = []
    const plugin = createRetryNowPlugin({
      runLoop: async (_config, options) => {
        calls.push(options)
        return {
          status: 'stopped-converged',
          iterations: 1,
          finalStreak: 5,
          threshold: 5,
        }
      },
    })
    const hooks = await loadHooks(plugin, client, join(root, 'plugin-project'))

    // When
    await hooks.event({
      type: 'command.executed',
      properties: { name: 'retry-now', sessionID: 'parent-1' },
    })

    // Then
    expect(client.getCalls).toEqual(['parent-1'])
    expect(calls[0]?.cwd).toBe(sessionRoot)
    expect(hooks.toolNames).toEqual([
      'retrynow_recover',
      'retrynow_start',
      'retrynow_status',
      'retrynow_stop',
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('retries a first-run command on idle after configuration appears', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-plugin-idle-'))
  try {
    // Given
    const client = fakeClient(() => root)
    const calls: DriverOptions[] = []
    const plugin = createRetryNowPlugin({
      runLoop: async (_config, options) => {
        calls.push(options)
        return {
          status: 'stopped-converged',
          iterations: 1,
          finalStreak: 5,
          threshold: 5,
        }
      },
    })
    const hooks = await loadHooks(plugin, client, root)
    await hooks.event({
      type: 'command.executed',
      properties: { name: 'retry-now', sessionID: 'parent-2' },
    })
    expect(calls).toHaveLength(0)
    await seedConfig(root)

    // When
    await hooks.event({ type: 'session.idle', properties: {} })

    // Then
    expect(calls).toHaveLength(1)
    expect(calls[0]?.cwd).toBe(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('falls back to the plugin directory when session lookup fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-plugin-fallback-'))
  try {
    // Given
    await seedConfig(root)
    const client = fakeClient(() => {
      throw new Error('session unavailable')
    })
    const calls: DriverOptions[] = []
    const plugin = createRetryNowPlugin({
      runLoop: async (_config, options) => {
        calls.push(options)
        return {
          status: 'stopped-converged',
          iterations: 1,
          finalStreak: 5,
          threshold: 5,
        }
      },
    })
    const hooks = await loadHooks(plugin, client, root)

    // When
    await hooks.event({
      type: 'command.executed',
      properties: { name: 'retry-now', sessionID: 'parent-3' },
    })

    // Then
    expect(calls[0]?.cwd).toBe(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('logs an auto-start failure and ignores unrelated events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-plugin-error-'))
  try {
    // Given
    await mkdir(join(root, '.retry-now'), { recursive: true })
    await writeFile(join(root, '.retry-now', 'config.json'), '{}\n', 'utf8')
    const logs: string[] = []
    const hooks = await loadHooks(
      createRetryNowPlugin({ log: (line) => logs.push(line) }),
      fakeClient(() => root),
      root,
    )

    // When
    await hooks.event({ type: 'message.updated', properties: {} })
    await hooks.event({
      type: 'command.executed',
      properties: { name: 'retry-now', sessionID: 'parent-4' },
    })

    // Then
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('retry-now auto-start failed:')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
