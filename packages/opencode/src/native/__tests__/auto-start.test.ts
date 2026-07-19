import { expect, test } from 'bun:test'

import { AutoStartCoordinator } from '../auto-start.ts'

/** A fake start whose loop only "takes hold" (activates) once `configReady` is true. */
function harness() {
  const calls: string[] = []
  const state = { configReady: false, active: false }
  const coordinator = new AutoStartCoordinator({
    start: async (parentSessionID) => {
      calls.push(parentSessionID)
      if (state.configReady) state.active = true
    },
    isActive: () => state.active,
    log: () => {},
  })
  return { coordinator, calls, state }
}

test('config already present: command.executed starts immediately and clears pending', async () => {
  // Given — config is ready, so the start takes hold
  const h = harness()
  h.state.configReady = true

  // When
  await h.coordinator.onCommandExecuted('ses_parent')

  // Then — started with the command's parent session
  expect(h.calls).toEqual(['ses_parent'])

  // And a later idle does NOT start again (pending cleared)
  await h.coordinator.onIdle()
  expect(h.calls).toEqual(['ses_parent'])
})

test('idle with no pending command does nothing', async () => {
  // Given
  const h = harness()
  h.state.configReady = true

  // When
  await h.coordinator.onIdle()

  // Then
  expect(h.calls).toEqual([])
})

test('first run: command.executed no-ops until config exists, then a later idle starts', async () => {
  // Given — config not written yet (interview in progress), so a start does not take hold
  const h = harness()

  // When — command fires but config not ready → attempt runs, stays inactive, pending retained
  await h.coordinator.onCommandExecuted('ses_parent')
  expect(h.calls).toEqual(['ses_parent'])
  expect(h.state.active).toBe(false)

  // an idle before config is ready: retries, still inactive, pending retained
  await h.coordinator.onIdle()
  expect(h.calls).toEqual(['ses_parent', 'ses_parent'])

  // interview finishes → config ready; the next idle starts and clears pending
  h.state.configReady = true
  await h.coordinator.onIdle()
  expect(h.calls).toEqual(['ses_parent', 'ses_parent', 'ses_parent'])

  // no further starts once active
  await h.coordinator.onIdle()
  expect(h.calls).toEqual(['ses_parent', 'ses_parent', 'ses_parent'])
})
