import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  type DriverOptions,
  type DriverResult,
  resolvePaths,
  type RetryNowConfig,
} from '@retry-now/core'

import { FakeNativeClient } from '../native/__tests__/fake-native-client.ts'
import { LoopController } from '../native/controller.ts'
import { RetryNowToolRuntime } from '../tools.ts'

function rawConfig(targets: readonly string[] = []): object {
  return {
    version: 1,
    agent: 'opencode',
    analysis: 'analyze everything',
    direction: 'improve safely',
    completion: 'all checks pass',
    threshold: 5,
    revertThreshold: 3,
    commitPerIteration: false,
    targets,
  }
}

export async function seedConfig(
  root: string,
  targets: readonly string[] = [],
): Promise<void> {
  const paths = resolvePaths(root)
  await mkdir(paths.dir, { recursive: true })
  await writeFile(
    paths.config,
    `${JSON.stringify(rawConfig(targets))}\n`,
    'utf8',
  )
}

export async function seedState(
  path: string,
  status: 'running' | 'stopped-converged',
  iteration: number,
  streak: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    `${JSON.stringify({
      status,
      iteration,
      noImprovementStreak: streak,
      threshold: 5,
      revertStreak: 0,
      revertThreshold: 3,
      startedAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
    })}\n`,
    'utf8',
  )
}

export async function withFixture(
  run: (fixture: {
    readonly root: string
    readonly client: FakeNativeClient
    readonly controller: LoopController
    readonly runtime: RetryNowToolRuntime
    readonly calls: DriverOptions[]
    setRunResult(result: Promise<DriverResult>): void
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-tools-'))
  const client = new FakeNativeClient()
  const controller = new LoopController(client)
  const calls: DriverOptions[] = []
  let runResult = Promise.resolve<DriverResult>({
    status: 'stopped-converged',
    iterations: 1,
    finalStreak: 5,
    threshold: 5,
  })
  const runtime = new RetryNowToolRuntime({
    client,
    controller,
    runLoop: async (_config: RetryNowConfig, options: DriverOptions) => {
      calls.push(options)
      return runResult
    },
  })
  try {
    await run({
      root,
      client,
      controller,
      runtime,
      calls,
      setRunResult(result): void {
        runResult = result
      },
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
