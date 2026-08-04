import { expect, test } from 'bun:test'

import { runDriverEntry } from '../driver-entry.ts'

test('returns the shared driver CLI exit code', async () => {
  // Given
  const argv = ['bun', 'driver-entry.ts', '--dry-run']

  // When
  const code = await runDriverEntry(argv, async (received) => {
    expect(received).toBe(argv)
    return 7
  })

  // Then
  expect(code).toBe(7)
})

test('reports a driver failure and returns one', async () => {
  // Given
  const errors: string[] = []
  const failure = new Error('driver failed')

  // When
  const code = await runDriverEntry(
    [],
    () => Promise.reject(failure),
    (line) => errors.push(line),
  )

  // Then
  expect(code).toBe(1)
  expect(errors[0]).toContain('driver failed')
})
