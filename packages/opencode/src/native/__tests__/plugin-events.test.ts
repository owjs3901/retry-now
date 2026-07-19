import { expect, test } from 'bun:test'

import { retryNowCommandSessionID } from '../plugin-events.ts'

test('returns the sessionID for a retry-now command.executed event', () => {
  // Given / When / Then
  expect(
    retryNowCommandSessionID({
      type: 'command.executed',
      properties: { name: 'retry-now', sessionID: 'ses_abc' },
    }),
  ).toBe('ses_abc')
})

test('ignores other commands, other event types, and malformed payloads', () => {
  // a different command (e.g. /goal) must not start retry-now
  expect(
    retryNowCommandSessionID({
      type: 'command.executed',
      properties: { name: 'goal', sessionID: 'ses_abc' },
    }),
  ).toBeUndefined()
  // not a command.executed event
  expect(
    retryNowCommandSessionID({
      type: 'session.idle',
      properties: { sessionID: 'ses_abc' },
    }),
  ).toBeUndefined()
  // missing sessionID
  expect(
    retryNowCommandSessionID({
      type: 'command.executed',
      properties: { name: 'retry-now' },
    }),
  ).toBeUndefined()
  // structurally malformed
  expect(retryNowCommandSessionID(undefined)).toBeUndefined()
  expect(retryNowCommandSessionID({ type: 'command.executed' })).toBeUndefined()
  expect(retryNowCommandSessionID('command.executed')).toBeUndefined()
})

test('honours a custom command name', () => {
  expect(
    retryNowCommandSessionID(
      {
        type: 'command.executed',
        properties: { name: 'retry-now-custom', sessionID: 'ses_z' },
      },
      'retry-now-custom',
    ),
  ).toBe('ses_z')
})
