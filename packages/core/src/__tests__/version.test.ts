import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'

import { readVersionFrom } from '../version.ts'

test('readVersionFrom returns a string version and falls back for invalid files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'retry-now-version-'))
  try {
    const valid = join(dir, 'valid.json')
    const missingVersion = join(dir, 'missing-version.json')
    const malformed = join(dir, 'malformed.json')
    await writeFile(valid, '{"version":"9.8.7"}\n')
    await writeFile(missingVersion, '{"version":7}\n')
    await writeFile(malformed, '{')

    expect(readVersionFrom(valid)).toBe('9.8.7')
    expect(readVersionFrom(missingVersion)).toBe('0.0.0')
    expect(readVersionFrom(malformed)).toBe('0.0.0')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
