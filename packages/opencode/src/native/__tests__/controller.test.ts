import { expect, test } from 'bun:test'

import { LoopController } from '../controller.ts'
import { FakeNativeClient } from './fake-native-client.ts'

const directory = 'C:/workspace/project'

test('auto-replies once to both permission event variants for a managed child', () => {
  // Given
  const client = new FakeNativeClient()
  const controller = new LoopController(client)
  controller.registerChild('child-1', { directory, skipPermissions: true })

  // When
  controller.handleEvent({
    type: 'permission.updated',
    properties: { id: 'permission-1', sessionID: 'child-1' },
  })
  controller.handleEvent({
    type: 'permission.asked',
    properties: { id: 'permission-2', sessionID: 'child-1' },
  })
  controller.handleEvent({
    type: 'permission.updated',
    properties: { id: 'permission-1', sessionID: 'child-1' },
  })

  // Then
  expect(client.permissionCalls).toEqual([
    {
      path: { id: 'child-1', permissionID: 'permission-1' },
      query: { directory },
      body: { response: 'once' },
    },
    {
      path: { id: 'child-1', permissionID: 'permission-2' },
      query: { directory },
      body: { response: 'once' },
    },
  ])
})

test('does not reply to permissions for unmanaged or opted-out children', () => {
  // Given
  const client = new FakeNativeClient()
  const controller = new LoopController(client)
  controller.registerChild('managed', { directory, skipPermissions: false })

  // When
  controller.handleEvent({
    type: 'permission.updated',
    properties: { id: 'permission-1', sessionID: 'unmanaged' },
  })
  controller.handleEvent({
    type: 'permission.asked',
    properties: { id: 'permission-2', sessionID: 'managed' },
  })

  // Then
  expect(client.permissionCalls).toHaveLength(0)
})

test('rejects a managed child waiter when session.error arrives', async () => {
  // Given
  const client = new FakeNativeClient()
  const controller = new LoopController(client)
  const abortController = new AbortController()
  controller.registerChild('child-1', { directory, skipPermissions: true })
  const waiter = controller.waitForChild(
    'child-1',
    1_000,
    abortController.signal,
  )
  const sdkError = {
    name: 'UnknownError',
    data: { message: 'provider crashed' },
  }

  // When
  controller.handleEvent({
    type: 'session.error',
    properties: { sessionID: 'child-1', error: sdkError },
  })

  // Then
  await expect(waiter).rejects.toEqual(
    expect.objectContaining({
      name: 'ChildSessionError',
      sessionID: 'child-1',
      payload: sdkError,
    }),
  )
})

test('resolves a managed child waiter for both idle event shapes', async () => {
  // Given
  const client = new FakeNativeClient()
  const controller = new LoopController(client)
  const abortController = new AbortController()
  controller.registerChild('child-idle', { directory, skipPermissions: true })
  controller.registerChild('child-status', {
    directory,
    skipPermissions: true,
  })
  const idleWaiter = controller.waitForChild(
    'child-idle',
    1_000,
    abortController.signal,
  )
  const statusWaiter = controller.waitForChild(
    'child-status',
    1_000,
    abortController.signal,
  )

  // When
  controller.handleEvent({
    type: 'session.idle',
    properties: { sessionID: 'child-idle' },
  })
  controller.handleEvent({
    type: 'session.status',
    properties: { sessionID: 'child-status', status: { type: 'idle' } },
  })

  // Then
  await expect(idleWaiter).resolves.toBeUndefined()
  await expect(statusWaiter).resolves.toBeUndefined()
})

test('tracks one active loop per directory and exposes stopping state', () => {
  // Given
  const controller = new LoopController(new FakeNativeClient())

  // When
  const first = controller.registerLoop(directory)
  const duplicate = controller.registerLoop(directory)
  controller.markLoopStopping(directory)

  // Then
  expect(first).toBe(true)
  expect(duplicate).toBe(false)
  expect(controller.getLoopStatus(directory)).toBe('stopping')
  controller.unregisterLoop(directory)
  expect(controller.getLoopStatus(directory)).toBeUndefined()
})

test('aborts every currently active child owned by the requested directory', async () => {
  // Given
  const client = new FakeNativeClient()
  const controller = new LoopController(client)
  controller.registerChild('child-1', { directory, skipPermissions: true })
  controller.registerChild('child-2', { directory, skipPermissions: true })
  controller.registerChild('other-child', {
    directory: 'C:/workspace/other',
    skipPermissions: true,
  })

  // When
  await controller.abortActive(directory)

  // Then
  expect(client.abortCalls).toEqual([
    { path: { id: 'child-1' }, query: { directory } },
    { path: { id: 'child-2' }, query: { directory } },
  ])
})
