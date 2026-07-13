import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'

import { formatIterationCommitMessage } from '../commit-message.ts'
import {
  commitPaths,
  type GitRunner,
  isSafeRepoFilePath,
  statusPaths,
} from '../git.ts'
import { validateImproveSignal } from '../improve-signal.ts'
import { converged, oathBlock, rebirth, revertConverged } from '../theme.ts'
import type { PlannedImprovement, Signal } from '../types.ts'

function signal(overrides: Partial<Signal>): Signal {
  return {
    iteration: 1,
    phase: 'improve',
    result: 'applied',
    report: 'report.md',
    summary: 'summary',
    timestamp: '2026-07-14T00:00:00.000Z',
    ...overrides,
  }
}

const PLAN: readonly PlannedImprovement[] = [{ id: '1', title: 'item' }]

test('legacy commit messages report applied and failed summary-only outcomes', () => {
  const applied = formatIterationCommitMessage('0001', signal({}))
  const failed = formatIterationCommitMessage(
    '0002',
    signal({ result: 'failed', plannedCount: 2 }),
  )

  expect(applied).toContain('(1/1 applied)')
  expect(applied).toContain('Details unavailable')
  expect(failed).toContain('(0/2 applied)')
})

test('improve validation explains unsafe impact and decision evidence', () => {
  const base = {
    id: '1',
    title: 'item',
    status: 'kept' as const,
    impact: 'faster',
    decisionReason: 'benchmark improved',
    files: ['src/item.ts'],
  }
  const complete = {
    plannedCount: 1,
    keptCount: 1,
    revertedCount: 0,
    failedCount: 0,
    skippedCount: 0,
  }

  expect(
    validateImproveSignal(
      signal({
        ...complete,
        appliedImprovements: [{ ...base, impact: 'bad\u0000impact' }],
      }),
      PLAN,
    ),
  ).toContain('impact is unsafe')
  expect(
    validateImproveSignal(
      signal({
        ...complete,
        appliedImprovements: [{ ...base, decisionReason: '' }],
      }),
      PLAN,
    ),
  ).toContain('must report decisionReason')
  expect(
    validateImproveSignal(
      signal({
        ...complete,
        appliedImprovements: [{ ...base, decisionReason: 'bad\u202ereason' }],
      }),
      PLAN,
    ),
  ).toContain('decisionReason is unsafe')
  expect(
    validateImproveSignal(
      signal({
        ...complete,
        keptCount: 0,
        appliedImprovements: [base],
      }),
      PLAN,
    ),
  ).toContain('summary counts')
})

test('improve validation accepts complete reverted and failed batches', () => {
  const outcome = {
    id: '1',
    title: 'item',
    impact: 'attempted simplification',
    decisionReason: 'verification rejected it',
  }
  const counts = {
    plannedCount: 1,
    keptCount: 0,
    skippedCount: 0,
  }

  expect(
    validateImproveSignal(
      signal({
        ...counts,
        result: 'applied_reverted',
        revertedCount: 1,
        failedCount: 0,
        appliedImprovements: [{ ...outcome, status: 'reverted' }],
      }),
      PLAN,
    ),
  ).toBeNull()
  expect(
    validateImproveSignal(
      signal({
        ...counts,
        result: 'failed',
        revertedCount: 0,
        failedCount: 1,
        appliedImprovements: [{ ...outcome, status: 'failed' }],
      }),
      PLAN,
    ),
  ).toBeNull()
})

test('Git boundaries reject malformed paths and parse rename records', async () => {
  expect(isSafeRepoFilePath('')).toBe(false)
  expect(isSafeRepoFilePath('x'.repeat(501))).toBe(false)
  expect(isSafeRepoFilePath('bad\u0000path')).toBe(false)

  const renamed: GitRunner = () =>
    Promise.resolve({
      code: 0,
      stdout: 'R  new.ts\0old.ts\0',
      stderr: '',
    })
  expect(await statusPaths('/repo', [], renamed)).toEqual(['new.ts', 'old.ts'])
})

test('commitPaths rejects empty input, directories, and failed staging', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'retry-now-coverage-'))
  const calls: string[][] = []
  const fake: GitRunner = (args) => {
    calls.push([...args])
    return Promise.resolve({ code: 0, stdout: '', stderr: '' })
  }
  try {
    expect((await commitPaths(dir, [], 'message', fake)).code).toBe(-1)
    await mkdir(join(dir, 'folder'))
    expect((await commitPaths(dir, ['folder'], 'message', fake)).code).toBe(-1)
    const failedCalls: string[][] = []
    const failingAdd: GitRunner = (args) => {
      failedCalls.push([...args])
      return Promise.resolve({ code: 7, stdout: '', stderr: 'cannot stage' })
    }
    expect(
      (await commitPaths(dir, ['deleted.txt'], 'message', failingAdd)).code,
    ).toBe(7)
    expect(failedCalls).toHaveLength(1)
    expect(failedCalls[0]?.[0]).toBe('add')
    expect(failedCalls.some((args) => args[0] === 'commit')).toBe(false)
    expect(calls).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('theme renders every user-facing lifecycle message', () => {
  expect(rebirth(3)).toContain('3번째 생')
  expect(converged(5)).toContain('5생 연속')
  expect(revertConverged(2)).toContain('2생 연속')
  expect(oathBlock()).toContain('운명이여, 무릎 꿇어라')
})
