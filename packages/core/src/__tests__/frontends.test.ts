import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

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

test('exports a dedicated plugin command-file builder that dispatches in-process', () => {
  // Given
  const pluginCommand = frontends.buildPluginCommandFile()

  // When / Then — the plugin runs the loop in-process; no external bun driver spawn.
  expect(pluginCommand.content).not.toContain('bun ')
  expect(pluginCommand.content).not.toContain('driver-entry')
})

test('drives STEP 2 from the plugin: no agent-callable tool and no agent pin', () => {
  // Given
  const pluginCommand = frontends.buildPluginCommandFile()

  // When
  const frontmatter = pluginCommand.content.split('---')[1] ?? ''

  // Then — the loop starts from the plugin's `command.executed` hook, so the agent calls NO tool
  // and the command is NOT pinned to any agent. That is what lets `/retry-now` run from ANY agent
  // (including a curated orchestrator that filters out plugin-registered tools).
  expect(frontmatter).not.toContain('agent:')
  expect(pluginCommand.content).not.toContain('retrynow_start')
  expect(pluginCommand.content).toContain('automatically')
})

test('leaves the CLI-installed opencode command WITHOUT an agent pin', () => {
  // The CLI `install opencode` frontend drives the external bun loop via Bash (a core tool every
  // agent already has), so it must NOT carry an agent pin either.
  const cliFrontend = frontends.buildFrontend('opencode', DRIVER)
  const frontmatter = cliFrontend.content.split('---')[1] ?? ''

  expect(frontmatter).not.toContain('agent: build')
})

const PLUGIN_COMMAND_CASES = [
  {
    name: 'status',
    build: frontends.buildPluginStatusCommandFile,
    projectPath: '.opencode/command/retry-now-status.md',
    homePath: '.config/opencode/command/retry-now-status.md',
    invoke: '/retry-now-status',
    instructions: [
      '.retry-now/state.json',
      '.retry-now/current.json',
      '.retry-now/logs/plugin.log',
      '.retry-now/iteration.json',
      'retry-now #NNNN',
      'before** restarting',
    ],
  },
  {
    name: 'stop',
    build: frontends.buildPluginStopCommandFile,
    projectPath: '.opencode/command/retry-now-stop.md',
    homePath: '.config/opencode/command/retry-now-stop.md',
    invoke: '/retry-now-stop',
    instructions: [
      'Write an EMPTY file at `.retry-now/STOP`',
      'halts at the next phase boundary',
      'Do NOT modify any other file',
    ],
  },
  {
    name: 'recover',
    build: frontends.buildPluginRecoverCommandFile,
    projectPath: '.opencode/command/retry-now-recover.md',
    homePath: '.config/opencode/command/retry-now-recover.md',
    invoke: '/retry-now-recover',
    instructions: [
      'bunx @retry-now/cli recover',
      'starting a new life first would absorb them into a fresh baseline',
      'and do NOT start the loop',
      'report it verbatim and stop',
    ],
  },
] as const

for (const commandCase of PLUGIN_COMMAND_CASES) {
  test(`builds the plugin ${commandCase.name} command contract`, () => {
    // Given / When
    const command = commandCase.build()

    // Then
    expect(command.projectPath).toBe(commandCase.projectPath)
    expect(command.homePath).toBe(commandCase.homePath)
    expect(command.invoke).toBe(commandCase.invoke)
    expect(command.content).toMatch(/^---\r?\ndescription:/)
    for (const instruction of commandCase.instructions) {
      expect(command.content).toContain(instruction)
    }
  })
}

test('installs a project frontend into a newly created command directory', async () => {
  // Given
  const projectRoot = await mkdtemp(join(tmpdir(), 'retry-now-project-'))

  try {
    // When
    const result = await frontends.installFrontend('claude', DRIVER, {
      cwd: projectRoot,
    })

    // Then
    const expectedDest = join(projectRoot, '.claude/commands/retry-now.md')
    const expectedContent = frontends.buildFrontend(
      'claude',
      `${DRIVER} --cwd "${projectRoot}"`,
    ).content
    expect(result).toEqual({
      dest: expectedDest,
      invoke: '/retry-now',
      personal: false,
    })
    expect(await readFile(expectedDest, 'utf8')).toBe(expectedContent)
  } finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
})

// `homedir()` reads a DIFFERENT environment variable per platform (`HOME` on POSIX, `USERPROFILE` on
// Windows), so overriding one of them redirects the personal install on that platform only and writes
// into the runner's REAL home everywhere else. The install takes an explicit `home` for exactly this.
test('keeps identical content when installing a personal frontend', async () => {
  // Given
  const homeRoot = await mkdtemp(join(tmpdir(), 'retry-now-home-'))
  const expectedDest = join(homeRoot, '.config/opencode/command/retry-now.md')
  const expectedContent = frontends.buildFrontend('opencode', DRIVER).content
  await mkdir(dirname(expectedDest), { recursive: true })
  await writeFile(expectedDest, expectedContent, 'utf8')

  try {
    // When
    const result = await frontends.installFrontend('opencode', DRIVER, {
      cwd: join(homeRoot, 'unrelated-project'),
      personal: true,
      home: homeRoot,
    })

    // Then
    expect(result).toEqual({
      dest: expectedDest,
      invoke: '/retry-now',
      personal: true,
    })
    expect(await readFile(expectedDest, 'utf8')).toBe(expectedContent)
    expect(expectedContent).not.toContain('--cwd')
  } finally {
    await rm(homeRoot, { recursive: true, force: true })
  }
})

test('replaces different content at an existing project destination', async () => {
  // Given
  const projectRoot = await mkdtemp(join(tmpdir(), 'retry-now-existing-'))
  const expectedDest = join(projectRoot, '.agents/skills/retry-now/SKILL.md')
  await mkdir(dirname(expectedDest), { recursive: true })
  await writeFile(expectedDest, 'stale frontend', 'utf8')

  try {
    // When
    const result = await frontends.installFrontend('codex', DRIVER, {
      cwd: projectRoot,
    })

    // Then
    const expectedContent = frontends.buildFrontend(
      'codex',
      `${DRIVER} --cwd "${projectRoot}"`,
    ).content
    expect(result.dest).toBe(expectedDest)
    expect(result.invoke).toBe('$retry-now')
    expect(result.personal).toBe(false)
    expect(await readFile(expectedDest, 'utf8')).toBe(expectedContent)
  } finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
})
