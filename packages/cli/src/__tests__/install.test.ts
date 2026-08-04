import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { expect, test } from 'bun:test'

import { runInstall } from '../install.ts'

test('rejects an unknown install agent and explains the valid choices', async () => {
  const errors: string[] = []
  const originalError = console.error
  console.error = (message?: unknown) => errors.push(String(message))
  try {
    expect(await runInstall('cli.ts', 'gemini', '.', false)).toBe(1)
    expect(errors.join('\n')).toContain('opencode | codex | claude')
    expect(errors.join('\n')).toContain('retry-now install claude')
  } finally {
    console.error = originalError
  }
})

test('writes a project trigger with the absolute cwd and baked CLI command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-install-'))
  try {
    expect(
      await runInstall('C:/tools/retry-now.ts', 'opencode', root, false),
    ).toBe(0)
    const command = await readFile(
      join(root, '.opencode', 'command', 'retry-now.md'),
      'utf8',
    )
    expect(command).toContain('bun "C:/tools/retry-now.ts" run')
    expect(command).toContain(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('passes personal installs to the frontend boundary', async () => {
  let receivedCwd = ''
  const code = await runInstall(
    'cli.ts',
    'claude',
    '.',
    true,
    async (_agent, _driver, options) => {
      receivedCwd = options.cwd
      return { dest: 'home-command.md', invoke: '/retry-now', personal: true }
    },
  )

  expect(code).toBe(0)
  expect(isAbsolute(receivedCwd)).toBe(true)
})
