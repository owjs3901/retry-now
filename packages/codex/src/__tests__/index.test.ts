import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildFrontend } from '@retry-now/core'
import { expect, test } from 'bun:test'

import { install, resolveDriverPath, runInstallerCli } from '../index.ts'

test('installs the Codex skill at the exact project path with parsed frontmatter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-codex-'))
  try {
    // Given / When
    const result = await install({ cwd: root })

    // Then
    const driver = resolveDriverPath(import.meta.resolve('../index.ts'))
    const expected = buildFrontend('codex', `bun "${driver}" --cwd "${root}"`)
    expect(result).toEqual({
      dest: join(root, '.agents', 'skills', 'retry-now', 'SKILL.md'),
      invoke: '$retry-now',
      personal: false,
    })
    expect(await readFile(result.dest, 'utf8')).toBe(expected.content)
    expect(expected.content.split('---')[1]).toContain('name: retry-now')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolves a compiled driver when the sibling JavaScript file exists', () => {
  // Given
  const sourceUrl = import.meta.url

  // When / Then
  expect(resolveDriverPath(sourceUrl, () => true)).toBe(
    join(import.meta.dir, 'driver-entry.js'),
  )
})

test('runs the installer CLI and reports its observable result', async () => {
  // Given
  const lines: string[] = []
  const installer = async () => ({
    dest: 'C:/project/.agents/skills/retry-now/SKILL.md',
    invoke: '$retry-now',
    personal: false,
  })

  // When
  const code = await runInstallerCli(
    ['--cwd', 'C:/project'],
    installer,
    (line) => lines.push(line),
    (line) => lines.push(line),
  )

  // Then
  expect(code).toBe(0)
  expect(lines).toEqual([
    '설치 완료 — codex (project)',
    '  파일 : C:/project/.agents/skills/retry-now/SKILL.md',
    '  호출 : $retry-now',
    '  (설정이 없으면 먼저 `retry-now init`)',
  ])
})

test('returns failure and reports an Error installer rejection', async () => {
  // Given
  const errors: string[] = []

  // When
  const code = await runInstallerCli(
    [],
    () => Promise.reject(new Error('install unavailable')),
    () => undefined,
    (line) => errors.push(line),
  )

  // Then
  expect(code).toBe(1)
  expect(errors).toEqual(['install unavailable'])
})
