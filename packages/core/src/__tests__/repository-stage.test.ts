import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { expect, test } from 'bun:test'

import { runGit, statusPaths } from '../git.ts'
import type { ItemStageRun } from '../improve-runner.ts'
import { createImproveStageExecutor } from '../improve-stage.ts'
import { resolveImproveItemPaths, resolvePaths } from '../paths.ts'
import type { BatchItemStatus, ImproveStage, Signal } from '../types.ts'

async function initRepo(
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-stage-'))
  await runGit(['init'], root)
  await runGit(['config', 'user.email', 'test@retry-now.local'], root)
  await runGit(['config', 'user.name', 'retry-now test'], root)
  await runGit(['config', 'commit.gpgsign', 'false'], root)
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, content)
  }
  await runGit(['add', '.'], root)
  await runGit(['commit', '-m', 'fixture'], root)
  return root
}

function stageRun(
  root: string,
  itemId: string,
  stage: ImproveStage,
): ItemStageRun {
  const itemIndex = Number(itemId) - 1
  return {
    role: stage === 'review' ? 'review' : 'improve',
    stage,
    item: { id: itemId, title: `item ${itemId}` },
    itemIndex,
    artifacts: resolveImproveItemPaths(
      resolvePaths(root),
      1,
      itemIndex,
      stage,
      itemId,
    ),
    message: '',
  }
}

function signal(
  run: ItemStageRun,
  status: BatchItemStatus,
  files: readonly string[] = [],
): Signal {
  return {
    iteration: 1,
    phase: 'improve',
    result: status === 'kept' ? 'applied' : 'applied_reverted',
    report: run.artifacts.report,
    appliedImprovements: [
      {
        id: run.item.id,
        title: run.item.title,
        status,
        ...(status === 'kept' ? { files } : {}),
      },
    ],
    plannedCount: 1,
    keptCount: status === 'kept' ? 1 : 0,
    revertedCount: status === 'reverted' ? 1 : 0,
    failedCount: status === 'failed' ? 1 : 0,
    skippedCount: status === 'skipped' ? 1 : 0,
    summary: status,
    timestamp: '2026-07-14T00:00:00.000Z',
  }
}

test('reverted review restores approved bytes when a later item touches the same file', async () => {
  const root = await initRepo({ 'src/shared.ts': 'base\n' })
  const paths = resolvePaths(root)
  try {
    const execute = createImproveStageExecutor({
      paths,
      scope: '',
      dryRun: false,
      initialBaseline: (await statusPaths(root)) ?? [],
      log: () => undefined,
      validate: () => null,
      executePhase: async (_stagePaths, _validate, _retryGuard, run) => {
        if (run.stage === 'implement') {
          await writeFile(
            join(root, 'src/shared.ts'),
            run.item.id === '1' ? 'approved\n' : 'rejected candidate\n',
          )
        }
        const status =
          run.item.id === '2' && run.stage === 'review' ? 'reverted' : 'kept'
        return { kind: 'ok', signal: signal(run, status, ['src/shared.ts']) }
      },
    })

    await execute(stageRun(root, '1', 'implement'))
    await execute(stageRun(root, '1', 'review'))
    await execute(stageRun(root, '2', 'implement'))
    const review = await execute(stageRun(root, '2', 'review'))

    expect(review.kind).toBe('ok')
    expect(await readFile(join(root, 'src/shared.ts'), 'utf8')).toBe(
      'approved\n',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('failed implementation restores the approved working tree', async () => {
  const root = await initRepo({ 'src/value.ts': 'base\n' })
  const paths = resolvePaths(root)
  try {
    const execute = createImproveStageExecutor({
      paths,
      scope: '',
      dryRun: false,
      initialBaseline: (await statusPaths(root)) ?? [],
      log: () => undefined,
      validate: () => null,
      executePhase: async () => {
        await writeFile(join(root, 'src/value.ts'), 'unreviewed\n')
        return { kind: 'failed' }
      },
    })

    expect((await execute(stageRun(root, '1', 'implement'))).kind).toBe(
      'failed',
    )
    expect(await readFile(join(root, 'src/value.ts'), 'utf8')).toBe('base\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('target-scoped stage rejects and removes an out-of-scope edit', async () => {
  const root = await initRepo({
    'packages/a/value.ts': 'a\n',
    'packages/b/value.ts': 'b\n',
  })
  const paths = resolvePaths(root)
  try {
    const execute = createImproveStageExecutor({
      paths,
      scope: 'packages/a',
      dryRun: false,
      initialBaseline: (await statusPaths(root, ['packages/a'])) ?? [],
      log: () => undefined,
      validate: () => null,
      executePhase: async (_stagePaths, _validate, _retryGuard, run) => {
        await writeFile(join(root, 'packages/b/value.ts'), 'escaped\n')
        return {
          kind: 'ok',
          signal: signal(run, 'kept', ['packages/b/value.ts']),
        }
      },
    })

    expect((await execute(stageRun(root, '1', 'implement'))).kind).toBe(
      'failed',
    )
    expect(await readFile(join(root, 'packages/b/value.ts'), 'utf8')).toBe(
      'b\n',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('stage-created commit is rejected before an independent review can start', async () => {
  const root = await initRepo({ 'src/value.ts': 'base\n' })
  const paths = resolvePaths(root)
  try {
    const expectedHead = (
      await runGit(['rev-parse', 'HEAD'], root)
    ).stdout.trim()
    const execute = createImproveStageExecutor({
      paths,
      scope: '',
      dryRun: false,
      initialBaseline: (await statusPaths(root)) ?? [],
      log: () => undefined,
      validate: () => null,
      executePhase: async (_stagePaths, _validate, _retryGuard, run) => {
        await writeFile(join(root, 'src/value.ts'), 'committed by agent\n')
        await runGit(['add', 'src/value.ts'], root)
        await runGit(['commit', '-m', 'unauthorized'], root)
        return { kind: 'ok', signal: signal(run, 'kept', ['src/value.ts']) }
      },
    })

    const outcome = await execute(stageRun(root, '1', 'implement'))
    expect(outcome.kind).toBe('head-changed')
    if (outcome.kind !== 'head-changed') return
    expect(outcome.expectedHead).toBe(expectedHead)
    expect(outcome.actualHead).not.toBe(expectedHead)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
