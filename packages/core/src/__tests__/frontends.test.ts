import { createHash } from 'node:crypto'

import { expect, test } from 'bun:test'

import * as frontends from '../frontends.ts'

const DRIVER = 'C:/retry-now/driver-entry.js'

const LEGACY_FRONTEND_HASHES = {
  opencode: 'c24f2270a261315be223d1a601085f2500e9e188e2eb57b378562767be14c817',
  claude: 'ea3a4f0ec2146b5f00a14d8553f6df9ae53da05f832850295a090fabd2748733',
  codex: '0a2b79fc47ecff37e1669673d10490b2913122e23355dce03da6f92ac2e03fbb',
} as const

for (const agent of ['opencode', 'claude', 'codex'] as const) {
  test(`keeps the ${agent} CLI-installed frontend byte-identical`, () => {
    // Given
    const frontend = frontends.buildFrontend(agent, DRIVER)

    // When
    const digest = createHash('sha256').update(frontend.content).digest('hex')

    // Then
    expect(digest).toBe(LEGACY_FRONTEND_HASHES[agent])
  })
}

test('exports a dedicated plugin command-file builder', () => {
  // Given
  const pluginCommand = frontends.buildPluginCommandFile()

  // When / Then
  expect(pluginCommand.content).toContain('`retrynow_start`')
  expect(pluginCommand.content).not.toContain('bun ')
  expect(pluginCommand.content).not.toContain('driver-entry')
})
