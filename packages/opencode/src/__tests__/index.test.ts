import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildPluginCommandFile } from '@retry-now/core'
import { expect, test } from 'bun:test'

const indexPath = join(import.meta.dir, '..', 'index.ts')

test('contains a homedir failure during import-time command registration', async () => {
  // Given
  const script = `
    import { spyOn } from 'bun:test'
    const os = await import('node:os')
    spyOn(os, 'homedir').mockImplementation(() => { throw new Error('home unavailable') })
    await import(${JSON.stringify(indexPath)})
  `

  // When
  const process = Bun.spawn([Bun.argv[0] ?? 'bun', '-e', script], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ])

  // Then
  expect(exitCode).toBe(0)
  expect(stderr).toContain('retry-now command registration failed')
  expect(stderr).toContain('home unavailable')
})

test('writes the command file to an injected home directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-index-'))
  try {
    // Given
    const automaticHome = join(root, 'automatic')
    const injectedHome = join(root, 'injected')
    const script = `
      import { spyOn } from 'bun:test'
      const os = await import('node:os')
      spyOn(os, 'homedir').mockImplementation(() => ${JSON.stringify(automaticHome)})
      const { ensureCommandFile } = await import(${JSON.stringify(indexPath)})
      ensureCommandFile(${JSON.stringify(injectedHome)})
    `

    // When
    const process = Bun.spawn([Bun.argv[0] ?? 'bun', '-e', script], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await process.exited

    // Then
    expect(exitCode).toBe(0)
    expect(
      await Bun.file(
        join(injectedHome, buildPluginCommandFile().homePath),
      ).text(),
    ).toBe(buildPluginCommandFile().content)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
