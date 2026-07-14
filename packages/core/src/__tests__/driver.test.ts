import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'

import { runGit } from '../git.ts'
import { readJson } from '../io.ts'
import { runAgent, runLoop } from '../loop-driver.ts'
import { resolvePaths } from '../paths.ts'
import type { RetryNowConfig, Signal } from '../types.ts'

function config(): RetryNowConfig {
  return {
    version: 1,
    agent: 'opencode',
    analysisAgent: 'opencode',
    improveAgent: 'codex',
    reviewAgent: 'claude',
    model: '',
    analysisModel: '',
    improveModel: 'openai/implementer',
    reviewModel: 'anthropic/reviewer',
    modelVariant: '',
    analysisVariant: '',
    improveVariant: 'xhigh',
    reviewVariant: 'max',
    agentProfile: '',
    analysis: 'Find two improvements.',
    direction: 'Make safe changes.',
    completion: 'No worthwhile changes remain.',
    threshold: 3,
    revertThreshold: 3,
    maxIterations: 1,
    skipPermissions: true,
    commitPerIteration: false,
    verifyEnabled: true,
    verifyTest: 'bun test',
    verifyLint: 'bun run lint',
    benchCommand: '',
    benchRuns: 3,
    improvementBatchSize: 2,
    waitForQuota: false,
    quotaPollMs: 1_000,
    maxQuotaWaitMs: 10_000,
    targets: [],
  }
}

test('agent run replaces stale quota output and flushes the current attempt before resolving', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-agent-log-'))
  const logPath = join(root, 'agent.log')
  try {
    await writeFile(logPath, 'account "old" returned 429\n')

    const code = await runAgent(
      process.execPath,
      ['-e', 'process.stdout.write("current attempt\\n")'],
      root,
      logPath,
      () => undefined,
    )

    expect(code).toBe(0)
    expect(await readFile(logPath, 'utf8')).toBe('current attempt\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('dry run executes each item through fresh implement then review stages', async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), 'retry-now-driver-'))
  const logs: string[] = []

  try {
    // When
    await runLoop(config(), {
      cwd: root,
      dryRun: true,
      waitForQuota: false,
      log: (line) => logs.push(line),
    })

    // Then
    const stageLines = logs.filter((line) => line.includes('fresh session'))
    expect(stageLines).toEqual([
      expect.stringContaining('item 1 implement'),
      expect.stringContaining('item 1 review'),
      expect.stringContaining('item 2 implement'),
      expect.stringContaining('item 2 review'),
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('dry run writes item-scoped artifacts and one canonical reviewed batch signal', async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), 'retry-now-driver-'))

  try {
    // When
    await runLoop(config(), {
      cwd: root,
      dryRun: true,
      waitForQuota: false,
      log: () => undefined,
    })

    // Then
    const paths = resolvePaths(root)
    const canonical = await readJson<Signal>(paths.signal)
    expect(canonical?.appliedImprovements?.map((item) => item.id)).toEqual([
      '1',
      '2',
    ])
    expect(canonical?.plannedCount).toBe(2)
    expect(
      await Bun.file(
        join(paths.dir, 'items', '0001-01-implement-1.signal.json'),
      ).exists(),
    ).toBe(true)
    expect(
      await Bun.file(
        join(paths.dir, 'items', '0001-01-implement-1.current.json'),
      ).exists(),
    ).toBe(true)
    expect(
      await Bun.file(
        join(paths.dir, 'items', '0001-01-review-1.signal.json'),
      ).exists(),
    ).toBe(true)
    expect(
      await Bun.file(
        join(paths.dir, 'items', '0001-02-implement-2.prompt.md'),
      ).exists(),
    ).toBe(true)
    expect(
      await Bun.file(
        join(paths.dir, 'reports', '0001-02-review-2.md'),
      ).exists(),
    ).toBe(true)
    expect(
      await Bun.file(join(paths.dir, 'logs', '0001-02-review-2.log')).exists(),
    ).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('persistent HEAD quarantine blocks reruns while the expected revision is absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-quarantine-'))
  const paths = resolvePaths(root)
  const logs: string[] = []
  try {
    await runGit(['init'], root)
    await runGit(['config', 'user.email', 'test@retry-now.local'], root)
    await runGit(['config', 'user.name', 'retry-now test'], root)
    await runGit(['config', 'commit.gpgsign', 'false'], root)
    await writeFile(join(root, 'value.txt'), 'base\n')
    await runGit(['add', '.'], root)
    await runGit(['commit', '-m', 'fixture'], root)
    const actualHead = (await runGit(['rev-parse', 'HEAD'], root)).stdout.trim()
    await mkdir(paths.dir, { recursive: true })
    await writeFile(
      paths.headQuarantine,
      `${JSON.stringify({
        expectedHead: 'expected-head',
        actualHead,
        iteration: 1,
        source: 'analyze',
        createdAt: '2026-07-14T00:00:00.000Z',
      })}\n`,
    )

    const result = await runLoop(config(), {
      cwd: root,
      dryRun: true,
      waitForQuota: false,
      log: (line) => logs.push(line),
    })

    expect(result.status).toBe('error')
    expect(await Bun.file(paths.headQuarantine).exists()).toBe(true)
    expect(logs.some((line) => line.includes('remains quarantined'))).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)

test('HEAD quarantine auto-clears only after the expected revision is restored', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-quarantine-'))
  const paths = resolvePaths(root)
  try {
    await runGit(['init'], root)
    await runGit(['config', 'user.email', 'test@retry-now.local'], root)
    await runGit(['config', 'user.name', 'retry-now test'], root)
    await runGit(['config', 'commit.gpgsign', 'false'], root)
    await writeFile(join(root, 'value.txt'), 'base\n')
    await runGit(['add', '.'], root)
    await runGit(['commit', '-m', 'fixture'], root)
    const expectedHead = (
      await runGit(['rev-parse', 'HEAD'], root)
    ).stdout.trim()
    await mkdir(paths.dir, { recursive: true })
    await writeFile(
      paths.headQuarantine,
      `${JSON.stringify({
        expectedHead,
        actualHead: 'rogue-head',
        iteration: 1,
        source: 'implement',
        createdAt: '2026-07-14T00:00:00.000Z',
      })}\n`,
    )

    const result = await runLoop(
      { ...config(), maxIterations: 0 },
      {
        cwd: root,
        dryRun: true,
        waitForQuota: false,
        log: () => undefined,
      },
    )

    expect(result.status).toBe('stopped-maxiter')
    expect(await Bun.file(paths.headQuarantine).exists()).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)
