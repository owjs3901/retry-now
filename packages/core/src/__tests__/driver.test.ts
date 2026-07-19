import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'

import type {
  AgentBackend,
  PhaseInvocationRequest,
  PhaseRunResult,
} from '../agent-backend.ts'
import { runGit } from '../git.ts'
import { readJson, writeJson, writeText } from '../io.ts'
import { runAgent, runLoop } from '../loop-driver.ts'
import { resolveImproveItemPaths, resolvePaths } from '../paths.ts'
import type { RetryNowConfig, Signal } from '../types.ts'

class FakeBackend implements AgentBackend {
  readonly calls: PhaseInvocationRequest[] = []

  constructor(
    private readonly execute: (
      request: PhaseInvocationRequest,
    ) => Promise<PhaseRunResult>,
  ) {}

  run(request: PhaseInvocationRequest): Promise<PhaseRunResult> {
    this.calls.push(request)
    return this.execute(request)
  }
}

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
    phaseTimeoutMs: 1_800_000,
  }
}

async function initializeRepository(root: string): Promise<void> {
  await runGit(['init'], root)
  await runGit(['config', 'user.email', 'test@retry-now.local'], root)
  await runGit(['config', 'user.name', 'retry-now test'], root)
  await runGit(['config', 'commit.gpgsign', 'false'], root)
  await writeFile(join(root, 'fixture.txt'), 'base\n')
  await runGit(['add', '.'], root)
  await runGit(['commit', '-m', 'fixture'], root)
}

function analyzeSignal(): Signal {
  return {
    iteration: 1,
    phase: 'analyze',
    result: 'improvements_found',
    report: '.retry-now/reports/0001-analyze.md',
    nextImprovement: 'first item',
    plannedImprovements: [{ id: '1', title: 'first item' }],
    summary: 'one improvement',
    timestamp: '2026-07-18T00:00:00.000Z',
  }
}

function itemSignal(request: PhaseInvocationRequest): Signal {
  if (request.item === undefined || request.reportPath === undefined) {
    throw new Error('item request metadata is required')
  }
  return {
    iteration: request.iteration,
    phase: 'improve',
    result: 'applied',
    report: request.reportPath,
    plannedCount: 1,
    appliedImprovements: [
      {
        id: request.item.id,
        title: request.item.title,
        status: 'kept',
        impact: 'verified',
        decisionReason: 'checks passed',
        files: ['fixture.txt'],
      },
    ],
    keptCount: 1,
    revertedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    summary: 'kept',
    timestamp: '2026-07-18T00:00:00.000Z',
  }
}

test('backend receives each fresh phase invocation with its role, title, and message', async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), 'retry-now-backend-'))
  const paths = resolvePaths(root)
  const backend = new FakeBackend(async (request) => {
    if (request.phase === 'analyze') {
      await writeJson(paths.signal, analyzeSignal())
    } else {
      if (
        request.item === undefined ||
        request.itemIndex === undefined ||
        request.stage === undefined
      ) {
        throw new Error('item stage metadata is required')
      }
      const artifacts = resolveImproveItemPaths(
        paths,
        request.iteration,
        request.itemIndex,
        request.stage,
        request.item.id,
      )
      if (request.stage === 'implement') {
        await writeText(join(root, 'fixture.txt'), 'improved\n')
      }
      await writeJson(artifacts.signal, itemSignal(request))
      await writeText(artifacts.report, `${request.stage} report\n`)
    }
    return { kind: 'exit', code: 0 }
  })

  try {
    await initializeRepository(root)

    // When
    await runLoop(
      { ...config(), improvementBatchSize: 1 },
      {
        cwd: root,
        dryRun: false,
        waitForQuota: false,
        backend,
        log: () => undefined,
      },
    )

    // Then
    expect(
      backend.calls.map(({ role, title, message }) => ({
        role,
        title,
        message,
      })),
    ).toEqual([
      {
        role: 'analyze',
        title: 'retry-now #0001 ANALYZE',
        message:
          'retry-now reincarnation. Iteration 1, phase ANALYZE (id 0001). You are a FRESH session with NO memory of any prior life. Read and obey .retry-now/prompts/analyze.md EXACTLY. Your FINAL action MUST be overwriting .retry-now/signal.json exactly as that file specifies.',
      },
      {
        role: 'improve',
        title: 'retry-now #0001 IMPROVE item 1 implement',
        message:
          'retry-now item 1 implement. You are a FRESH top-level session with no continuation or resume context. Read and obey .retry-now/items/0001-01-implement-1.prompt.md. Your final action must overwrite .retry-now/items/0001-01-implement-1.signal.json.',
      },
      {
        role: 'review',
        title: 'retry-now #0001 IMPROVE item 1 review',
        message:
          'retry-now item 1 review. You are a FRESH top-level session with no continuation or resume context. Read and obey .retry-now/items/0001-01-review-1.prompt.md. Your final action must overwrite .retry-now/items/0001-01-review-1.signal.json.',
      },
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)

test('every phase invocation carries config.phaseTimeoutMs as the request timeout', async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), 'retry-now-backend-timeout-'))
  const backend = new FakeBackend(() => Promise.resolve({ kind: 'quota' }))

  try {
    await initializeRepository(root)

    // When
    await runLoop(
      { ...config(), phaseTimeoutMs: 123_456 },
      {
        cwd: root,
        dryRun: false,
        waitForQuota: false,
        backend,
        log: () => undefined,
      },
    )

    // Then
    expect(backend.calls.map(({ timeoutMs }) => timeoutMs)).toEqual([123_456])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)

test('backend quota result pauses the loop without spending crash retries', async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), 'retry-now-backend-quota-'))
  const backend = new FakeBackend(() => Promise.resolve({ kind: 'quota' }))

  try {
    await initializeRepository(root)

    // When
    const result = await runLoop(config(), {
      cwd: root,
      dryRun: false,
      waitForQuota: false,
      backend,
      log: () => undefined,
    })

    // Then
    expect(result.status).toBe('paused-quota')
    expect(backend.calls).toHaveLength(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)

test('backend nonzero exit without a valid signal exhausts phase attempts', async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), 'retry-now-backend-exit-'))
  const backend = new FakeBackend(() =>
    Promise.resolve({ kind: 'exit', code: 1 }),
  )

  try {
    await initializeRepository(root)

    // When
    const result = await runLoop(config(), {
      cwd: root,
      dryRun: false,
      waitForQuota: false,
      backend,
      log: () => undefined,
    })

    // Then
    expect(backend.calls).toHaveLength(3)
    expect(result.status).toBe('error')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)

test('backend aborted result stops the loop cleanly', async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), 'retry-now-backend-abort-'))
  const backend = new FakeBackend(() => Promise.resolve({ kind: 'aborted' }))

  try {
    await initializeRepository(root)

    // When
    const result = await runLoop(config(), {
      cwd: root,
      dryRun: false,
      waitForQuota: false,
      backend,
      log: () => undefined,
    })

    // Then
    expect(result.status).toBe('stopped-manual')
    expect(backend.calls).toHaveLength(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)

test('ANALYZE restoration log lists at most ten changed paths', async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), 'retry-now-analyze-log-'))
  const paths = resolvePaths(root)
  const logs: string[] = []
  const backend = new FakeBackend(async () => {
    await mkdir(join(root, 'src'), { recursive: true })
    for (let index = 1; index <= 12; index++) {
      await writeFile(
        join(root, 'src', `change-${String(index).padStart(2, '0')}.ts`),
        'changed\n',
      )
    }
    await writeJson(paths.signal, analyzeSignal())
    return { kind: 'exit', code: 0 }
  })

  try {
    await initializeRepository(root)

    // When
    const result = await runLoop(config(), {
      cwd: root,
      dryRun: false,
      waitForQuota: false,
      backend,
      log: (line) => logs.push(line),
    })

    // Then
    expect(result.status).toBe('error')
    expect(logs).toContain(
      '[repo][1] ANALYZE가 저장소를 변경하여 시작 상태로 복원하고 중단했습니다. — 변경: src/change-01.ts, src/change-02.ts, src/change-03.ts, src/change-04.ts, src/change-05.ts, src/change-06.ts, src/change-07.ts, src/change-08.ts, src/change-09.ts, src/change-10.ts 외 2개',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)

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
