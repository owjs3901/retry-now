import { expect, test } from 'bun:test'

import { runDriverEntry } from '../driver-entry.ts'

test('returns the shared driver CLI exit code', async () => {
  // Given / When
  const code = await runDriverEntry([], () => Promise.resolve(0))

  // Then
  expect(code).toBe(0)
})

test('reports a non-Error driver failure and returns one', async () => {
  // Given
  const errors: string[] = []

  // When
  const code = await runDriverEntry(
    [],
    () => Promise.reject('driver unavailable'),
    (line) => errors.push(line),
  )

  // Then
  expect(code).toBe(1)
  expect(errors).toEqual(['driver unavailable'])
})
