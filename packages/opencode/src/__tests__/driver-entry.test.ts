import { expect, test } from 'bun:test'

import { runDriverEntry } from '../driver-entry.ts'

test('returns the shared driver CLI exit code', async () => {
  // Given / When
  const code = await runDriverEntry([], () => Promise.resolve(0))

  // Then
  expect(code).toBe(0)
})

test('reports a driver Error without a stack and returns one', async () => {
  // Given
  const errors: string[] = []
  const failure = new Error('driver unavailable')
  delete failure.stack

  // When
  const code = await runDriverEntry(
    [],
    () => Promise.reject(failure),
    (line) => errors.push(line),
  )

  // Then
  expect(code).toBe(1)
  expect(errors).toEqual(['driver unavailable'])
})
