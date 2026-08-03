/**
 * `retry-now recover` — reconstructing a life whose driver was killed mid-batch.
 *
 * These tests reproduce the REPORTED incident against a real Git repository. In life 44 of a 22-hour
 * run, a host restart killed the in-process driver while item 5 of 5 was under review. Items 1-4 had
 * already passed independent review but were uncommitted, because commits only happened at the end of
 * a batch — so starting the next life would have absorbed them into a fresh baseline and destroyed
 * their provenance, evidence, and review verdicts.
 *
 * The load-bearing case is the SHARED FILE: item 3 and item 5 both edited `src/update.rs`. Item 5's
 * backup is by construction `HEAD + item(1..4)`, so restoring it must strip item 5's edit while
 * PRESERVING item 3's. That property is the reason per-item backups must never be collapsed into a
 * per-stage or per-batch backup, so it is asserted directly.
 */
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { expect, test } from 'bun:test'

import { runGit } from '../git.ts'
import { exists } from '../io.ts'
import {
  pad,
  resolveImproveItemPaths,
  resolvePaths,
  slugifyTarget,
} from '../paths.ts'
import { recoverProject, writeIterationRecord } from '../recover.ts'
import type {
  CommandRunner,
  LoopState,
  PlannedImprovement,
  Signal,
} from '../types.ts'

const ITERATION = 44
const GREEN: CommandRunner = () => Promise.resolve(0)
const RED: CommandRunner = () => Promise.resolve(1)
const DEAD = (): boolean => false

const PLAN: readonly PlannedImprovement[] = [
  { id: '1', title: 'Tighten alpha', risk: 'low' },
  { id: '2', title: 'Tighten beta', risk: 'low' },
  { id: '3', title: 'Rewrite the update map', risk: 'medium' },
  { id: '4', title: 'Tighten delta', risk: 'low' },
  { id: '5', title: 'Reuse the update map in the writer', risk: 'medium' },
]

/** What each reviewed item changed, and to what content. */
const KEPT: Readonly<Record<string, readonly [string, string]>> = {
  '1': ['src/alpha.rs', 'alpha item1\n'],
  '2': ['src/beta.rs', 'beta item2\n'],
  '3': ['src/update.rs', 'update item3\n'],
  '4': ['src/delta.rs', 'delta item4\n'],
}

async function write(root: string, rel: string, body: string): Promise<void> {
  const absolute = join(root, rel)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, body, 'utf8')
}

async function writeJsonFile(
  root: string,
  rel: string,
  value: unknown,
): Promise<void> {
  await write(root, rel, `${JSON.stringify(value, null, 2)}\n`)
}

function reviewSignal(item: PlannedImprovement, file: string): Signal {
  return {
    iteration: ITERATION,
    phase: 'improve',
    result: 'applied',
    report: '(set by recover)',
    plannedCount: 1,
    appliedImprovements: [
      {
        id: item.id,
        title: item.title,
        status: 'kept',
        impact: `independently verified improvement for item ${item.id}`,
        decisionReason: `reviewed in a fresh session; tests and lint re-run green for item ${item.id}`,
        files: [file],
      },
    ],
    keptCount: 1,
    revertedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    summary: `kept item ${item.id}`,
    timestamp: '2026-07-30T00:00:00.000Z',
  }
}

/** A valid terminal verdict that KEPT nothing, so recovery has no committable prefix. */
function revertedSignal(item: PlannedImprovement): Signal {
  return {
    iteration: ITERATION,
    phase: 'improve',
    result: 'applied_reverted',
    report: '(set by recover)',
    plannedCount: 1,
    appliedImprovements: [
      {
        id: item.id,
        title: item.title,
        status: 'reverted',
        impact: `attempted improvement for item ${item.id}`,
        decisionReason: `independent review restored the backup for item ${item.id}`,
        files: [],
      },
    ],
    keptCount: 0,
    revertedCount: 1,
    failedCount: 0,
    skippedCount: 0,
    summary: `reverted item ${item.id}`,
    timestamp: '2026-07-30T00:00:00.000Z',
  }
}

type FixtureOptions = {
  /** how many leading items have a valid review signal on disk (default 4) */
  readonly reviewed?: number
  /** write the boundary item's backup directory (default true) */
  readonly backupBoundary?: boolean
  /** the boundary item left partial edits and artifacts behind (default true) */
  readonly boundaryWorked?: boolean
  /** also leave a review signal for the LAST item, creating a non-contiguous prefix */
  readonly reviewGapAtLast?: boolean
  /** leave a stale dead-pid driver.lock, as a killed driver does (default true) */
  readonly staleLock?: boolean
  /** reviewed items report `reverted` instead of `kept`, so nothing is committable */
  readonly revertAll?: boolean
  /** corrupt the plan with duplicate ids so the rebuilt batch signal cannot validate */
  readonly duplicatePlanIds?: boolean
  readonly targets?: readonly string[]
  readonly stateStatus?: LoopState['status']
}

/**
 * Build a repository frozen at the exact moment the driver died: the first `reviewed` items reviewed
 * and kept but UNCOMMITTED, and the NEXT item ("the boundary") half-applied with no review verdict.
 */
async function fixture(
  options: FixtureOptions = {},
): Promise<{ root: string; head: string }> {
  const reviewed = options.reviewed ?? 4
  const root = await mkdtemp(join(tmpdir(), 'retry-now-recover-'))
  await runGit(['init'], root)
  // Identity and signing are written STRAIGHT INTO .git/config rather than through three `git config`
  // spawns. Every test here needs a real repository, and on Windows process creation dominates their
  // cost — enough that the extra spawns pushed the whole suite past the 15s budget the existing
  // real-git tests in `repository-stage.test.ts` run under, making them flake.
  await appendFile(
    join(root, '.git', 'config'),
    '[user]\n\temail = test@retry-now.local\n\tname = retry-now test\n[commit]\n\tgpgsign = false\n',
    'utf8',
  )
  for (const name of ['alpha', 'beta', 'update', 'delta']) {
    await write(root, `src/${name}.rs`, `${name} base\n`)
  }
  await write(root, '.retry-now/.gitignore', '*\n')
  await runGit(['add', '.'], root)
  // `commit` reports the new revision, so HEAD comes free instead of costing a `rev-parse` spawn.
  await runGit(['commit', '-m', 'fixture base'], root)
  const head = (await runGit(['rev-parse', 'HEAD'], root)).stdout.trim()

  if (options.staleLock !== false) {
    await writeJsonFile(root, '.retry-now/driver.lock', {
      pid: 999_999,
      root,
      startedAt: '2026-07-30T00:00:00.000Z',
    })
  }
  const targets = options.targets ?? []
  await writeJsonFile(root, '.retry-now/config.json', {
    version: 1,
    analysis: 'analyze everything',
    direction: 'smallest correct change',
    completion: 'nothing left worth doing',
    commitPerIteration: true,
    verifyEnabled: true,
    verifyTest: 'cargo test',
    verifyLint: 'cargo clippy -- -D warnings',
    improvementBatchSize: 8,
    ...(targets.length > 0 ? { targets } : {}),
  })

  const slug = targets[0] === undefined ? undefined : slugifyTarget(targets[0])
  const paths = resolvePaths(root, slug)
  const stateRel = (absolute: string): string =>
    absolute.slice(root.length + 1).replace(/\\/g, '/')

  const state: LoopState = {
    status: options.stateStatus ?? 'running',
    iteration: ITERATION - 1,
    noImprovementStreak: 0,
    threshold: 5,
    revertStreak: 0,
    revertThreshold: 3,
    startedAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
  }
  await writeJsonFile(root, stateRel(paths.state), state)
  await writeJsonFile(root, stateRel(paths.iterationRecord), {
    iteration: ITERATION,
    baselineHead: head,
    plannedCount: PLAN.length,
    scope: targets[0] ?? '',
    startedAt: '2026-07-30T00:00:00.000Z',
  })
  const plan: readonly PlannedImprovement[] =
    options.duplicatePlanIds === true
      ? PLAN.map((item) => ({ ...item, id: '1' }))
      : PLAN
  await writeJsonFile(root, stateRel(paths.signal), {
    iteration: ITERATION,
    phase: 'analyze',
    result: 'improvements_found',
    report: `.retry-now/reports/${pad(ITERATION)}-analyze.md`,
    nextImprovement: plan[0]?.title,
    plannedImprovements: plan,
    summary: 'five ranked improvements',
    timestamp: '2026-07-30T00:00:00.000Z',
  })
  await writeJsonFile(root, stateRel(paths.current), {
    iteration: ITERATION,
    padded: pad(ITERATION),
    phase: 'analyze',
  })

  // Items 1..reviewed: apply the change AND leave a valid review verdict on disk.
  for (const [index, item] of plan.entries()) {
    const kept = KEPT[PLAN[index]?.id ?? '']
    if (index >= reviewed || kept === undefined) continue
    if (options.revertAll !== true) await write(root, kept[0], kept[1])
    const artifacts = resolveImproveItemPaths(
      paths,
      ITERATION,
      index,
      'review',
      item.id,
    )
    await write(root, stateRel(artifacts.report), `# item ${item.id} review\n`)
    await writeJsonFile(
      root,
      stateRel(artifacts.signal),
      options.revertAll === true
        ? revertedSignal(item)
        : reviewSignal(item, kept[0]),
    )
  }

  // The BOUNDARY item: half-applied, no review verdict. It re-edits update.rs — which item 3 already
  // edited when `reviewed >= 3` — and creates a brand-new file, so a correct rollback must restore
  // the content items 1..reviewed produced and delete the new file.
  const boundary = plan[reviewed]
  if (boundary !== undefined && options.boundaryWorked !== false) {
    const artifacts = resolveImproveItemPaths(
      paths,
      ITERATION,
      reviewed,
      'review',
      boundary.id,
    )
    // Whatever update.rs held BEFORE the boundary item touched it: item 3's content if item 3 was
    // among the reviewed items, otherwise the committed base.
    const beforeBoundary =
      reviewed >= 3 && options.revertAll !== true
        ? 'update item3\n'
        : 'update base\n'
    await write(root, 'src/update.rs', 'update boundary PARTIAL\n')
    await write(root, 'src/brand_new.rs', 'created by the boundary item\n')
    await write(
      root,
      stateRel(artifacts.report),
      `# item ${boundary.id} implement\n`,
    )
    if (options.backupBoundary !== false) {
      await write(
        root,
        `${stateRel(artifacts.backupDir)}/src/update.rs`,
        beforeBoundary,
      )
      await write(
        root,
        stateRel(artifacts.newFiles),
        '# files this item created\nsrc/brand_new.rs\n',
      )
    }
  }

  const last = plan[plan.length - 1]
  if (options.reviewGapAtLast === true && last !== undefined) {
    const artifacts = resolveImproveItemPaths(
      paths,
      ITERATION,
      plan.length - 1,
      'review',
      last.id,
    )
    await write(root, stateRel(artifacts.report), `# item ${last.id} review\n`)
    await writeJsonFile(
      root,
      stateRel(artifacts.signal),
      reviewSignal(last, 'src/update.rs'),
    )
  }
  return { root, head }
}

async function read(root: string, rel: string): Promise<string> {
  return readFile(join(root, rel), 'utf8')
}

test('recovers the reported life-44 interruption: keeps reviewed work, rolls back the unreviewed item', async () => {
  const { root, head } = await fixture()
  try {
    const { reports, code } = await recoverProject(root, {
      commandRunner: GREEN,
      alive: DEAD,
    })
    const report = reports[0]
    expect(code).toBe(0)
    expect(report?.status).toBe('recovered')
    expect(report?.iteration).toBe(ITERATION)
    expect(report?.keptCount).toBe(4)
    expect(report?.plannedCount).toBe(5)
    expect(report?.rolledBack).toEqual(['5'])
    expect(report?.committed).toBe(true)

    // THE shared-file property: item 3's edit survives, the boundary item's is stripped.
    expect(await read(root, 'src/update.rs')).toBe('update item3\n')
    expect(await exists(join(root, 'src/brand_new.rs'))).toBe(false)
    expect(await read(root, 'src/alpha.rs')).toBe('alpha item1\n')
    expect(await read(root, 'src/delta.rs')).toBe('delta item4\n')

    // The reviewed prefix is now durable history, not floating working-tree state.
    const log = await runGit(['log', '--format=%H%n%B', '-1'], root)
    expect(log.stdout).toContain(`retry-now#${pad(ITERATION)}`)
    expect(log.stdout).toContain('(4/5 applied)')
    expect(log.stdout).toContain('Recovered by retry-now recover')
    expect(log.stdout).toContain('Item 5 was rolled back')
    expect((await runGit(['rev-parse', 'HEAD'], root)).stdout.trim()).not.toBe(
      head,
    )
    expect((await runGit(['status', '--porcelain'], root)).stdout).toBe('')

    const state = JSON.parse(
      await read(root, '.retry-now/state.json'),
    ) as LoopState
    expect(state.iteration).toBe(ITERATION)
    expect(state.status).toBe('interrupted')

    // Consumed artifacts are gone, so a second recover cannot re-read a stale prefix.
    expect(await exists(join(root, '.retry-now/iteration.json'))).toBe(false)
    expect(
      await exists(join(root, `.retry-now/backups/${pad(ITERATION)}`)),
    ).toBe(false)
    expect(await exists(join(root, '.retry-now/driver.lock'))).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('a second recover is a clean no-op', async () => {
  const { root } = await fixture()
  try {
    await recoverProject(root, { commandRunner: GREEN, alive: DEAD })
    const { reports, code } = await recoverProject(root, {
      commandRunner: GREEN,
      alive: DEAD,
    })
    expect(code).toBe(0)
    expect(reports[0]?.status).toBe('clean')
    expect(reports[0]?.committed).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('an already-interrupted state is still recoverable (F3 ran first)', async () => {
  const { root } = await fixture({ stateStatus: 'interrupted' })
  try {
    const { reports } = await recoverProject(root, {
      commandRunner: GREEN,
      alive: DEAD,
    })
    expect(reports[0]?.status).toBe('recovered')
    expect(reports[0]?.keptCount).toBe(4)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('REFUSES while a live driver still holds the project lock', async () => {
  const { root } = await fixture()
  try {
    await writeJsonFile(root, '.retry-now/driver.lock', {
      pid: 424_242,
      root,
      startedAt: '2026-07-30T00:00:00.000Z',
    })
    const { reports, code } = await recoverProject(root, {
      commandRunner: GREEN,
      alive: () => true,
    })
    expect(code).toBe(1)
    expect(reports[0]?.status).toBe('refused')
    expect(reports[0]?.reason).toContain('pid 424242')
    // Nothing touched: the live driver's work is untouched.
    expect(await read(root, 'src/update.rs')).toBe('update boundary PARTIAL\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('REFUSES when the unreviewed item worked but left no backup', async () => {
  const { root } = await fixture({ backupBoundary: false })
  try {
    const { reports, code } = await recoverProject(root, {
      commandRunner: GREEN,
      alive: DEAD,
    })
    expect(code).toBe(1)
    expect(reports[0]?.status).toBe('refused')
    expect(reports[0]?.reason).toContain('백업 디렉터리')
    // Refusal means refusal: the half-applied item is NOT committed and NOT guessed at.
    expect(await read(root, 'src/update.rs')).toBe('update boundary PARTIAL\n')
    expect(
      (await runGit(['rev-list', '--count', 'HEAD'], root)).stdout.trim(),
    ).toBe('1')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('REFUSES when review signals are not a contiguous prefix', async () => {
  const { root } = await fixture({ reviewed: 2, reviewGapAtLast: true })
  try {
    const { reports, code } = await recoverProject(root, {
      commandRunner: GREEN,
      alive: DEAD,
    })
    expect(code).toBe(1)
    expect(reports[0]?.status).toBe('refused')
    expect(reports[0]?.reason).toContain('연속 prefix')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('REFUSES when a commit appeared during the batch (HEAD moved)', async () => {
  const { root } = await fixture()
  try {
    await write(root, 'src/rogue.rs', 'agent commit\n')
    await runGit(['add', 'src/rogue.rs'], root)
    await runGit(['commit', '-m', 'rogue agent commit'], root)
    const { reports, code } = await recoverProject(root, {
      commandRunner: GREEN,
      alive: DEAD,
    })
    expect(code).toBe(1)
    expect(reports[0]?.status).toBe('refused')
    expect(reports[0]?.reason).toContain('Git HEAD')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('rolls back but REFUSES to commit when verification is red', async () => {
  const { root } = await fixture()
  try {
    const { reports, code } = await recoverProject(root, {
      commandRunner: RED,
      alive: DEAD,
    })
    expect(code).toBe(1)
    expect(reports[0]?.status).toBe('refused')
    expect(reports[0]?.reason).toContain('검증이 실패')
    // The unreviewed item is still correctly stripped, but nothing is committed on a red tree.
    expect(await read(root, 'src/update.rs')).toBe('update item3\n')
    expect(
      (await runGit(['rev-list', '--count', 'HEAD'], root)).stdout.trim(),
    ).toBe('1')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('REFUSES when residue exists but no IMPROVE transaction was recorded', async () => {
  const { root } = await fixture()
  try {
    await rm(join(root, '.retry-now/iteration.json'), { force: true })
    const { reports, code } = await recoverProject(root, {
      commandRunner: GREEN,
      alive: DEAD,
    })
    expect(code).toBe(1)
    expect(reports[0]?.status).toBe('refused')
    expect(reports[0]?.reason).toContain('IMPROVE 트랜잭션 기록')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('a terminal status is left alone as already honest', async () => {
  const { root } = await fixture({ stateStatus: 'stopped-converged' })
  try {
    const { reports, code } = await recoverProject(root, {
      commandRunner: GREEN,
      alive: DEAD,
    })
    expect(code).toBe(0)
    expect(reports[0]?.status).toBe('clean')
    expect(reports[0]?.reason).toBeNull()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('refuses when the project has no config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-recover-bare-'))
  try {
    const { reports, code } = await recoverProject(root, {
      commandRunner: GREEN,
      alive: DEAD,
    })
    expect(code).toBe(1)
    expect(reports[0]?.status).toBe('refused')
    expect(reports[0]?.reason).toContain('config.json')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('recovers a per-package target loop under .retry-now/targets/<slug>/', async () => {
  const { root } = await fixture({ targets: ['src'] })
  try {
    const { reports, code } = await recoverProject(root, {
      commandRunner: GREEN,
      alive: DEAD,
    })
    expect(code).toBe(0)
    expect(reports[0]?.status).toBe('recovered')
    expect(reports[0]?.target).toBe('src')
    expect(await read(root, 'src/update.rs')).toBe('update item3\n')
    const state = JSON.parse(
      await read(root, '.retry-now/targets/src/state.json'),
    ) as LoopState
    expect(state.status).toBe('interrupted')
    expect(state.iteration).toBe(ITERATION)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('a target with no state.json at all is clean', async () => {
  const { root } = await fixture()
  try {
    await rm(join(root, '.retry-now/state.json'), { force: true })
    const { reports, code } = await recoverProject(root, {
      commandRunner: GREEN,
      alive: DEAD,
    })
    expect(code).toBe(0)
    expect(reports[0]?.status).toBe('clean')
    expect(reports[0]?.iteration).toBeNull()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('REFUSES while an unauthorized-HEAD quarantine is active', async () => {
  const { root } = await fixture()
  try {
    await writeJsonFile(root, '.retry-now/HEAD_CHANGED.json', {
      expectedHead: 'a'.repeat(40),
      actualHead: 'b'.repeat(40),
    })
    const { reports, code } = await recoverProject(root, {
      commandRunner: GREEN,
      alive: DEAD,
    })
    expect(code).toBe(1)
    expect(reports[0]?.reason).toContain('HEAD 격리')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('REFUSES when Git HEAD cannot be read at all', async () => {
  const { root } = await fixture()
  try {
    const { reports, code } = await recoverProject(root, {
      commandRunner: GREEN,
      alive: DEAD,
      git: (args, cwd) =>
        args[0] === 'rev-parse'
          ? Promise.resolve({ code: 1, stdout: '', stderr: 'no head' })
          : runGit(args, cwd),
    })
    expect(code).toBe(1)
    expect(reports[0]?.reason).toContain('Git HEAD를 읽을 수 없습니다')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('REFUSES when the authoritative ANALYZE plan cannot be recovered', async () => {
  const { root } = await fixture()
  try {
    await rm(join(root, '.retry-now/signal.json'), { force: true })
    const { reports, code } = await recoverProject(root, {
      commandRunner: GREEN,
      alive: DEAD,
    })
    expect(code).toBe(1)
    expect(reports[0]?.reason).toContain('ANALYZE 계획')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('REFUSES when a backup path would escape the repository', async () => {
  const { root } = await fixture()
  try {
    const paths = resolvePaths(root)
    const artifacts = resolveImproveItemPaths(
      paths,
      ITERATION,
      4,
      'review',
      '5',
    )
    await writeFile(artifacts.newFiles, '../outside-the-repo.rs\n', 'utf8')
    const { reports, code } = await recoverProject(root, {
      commandRunner: GREEN,
      alive: DEAD,
    })
    expect(code).toBe(1)
    expect(reports[0]?.reason).toContain('롤백 실패')
    expect(reports[0]?.reason).toContain('unsafe repository-relative path')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('an unreviewed item that never started leaves nothing to roll back', async () => {
  const { root } = await fixture({ boundaryWorked: false })
  try {
    const { reports, code } = await recoverProject(root, {
      commandRunner: GREEN,
      alive: DEAD,
    })
    expect(code).toBe(0)
    expect(reports[0]?.status).toBe('recovered')
    expect(reports[0]?.rolledBack).toEqual([])
    expect(reports[0]?.keptCount).toBe(4)
    expect(reports[0]?.lines.join('\n')).toContain('시작 흔적이 없어')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('items after the boundary are recorded as skipped, not failed', async () => {
  // Only items 1-2 were reviewed: item 3 is the boundary (failed), items 4-5 never ran (skipped).
  const { root } = await fixture({ reviewed: 2 })
  try {
    const { reports, code } = await recoverProject(root, {
      commandRunner: GREEN,
      alive: DEAD,
    })
    expect(code).toBe(0)
    expect(reports[0]?.status).toBe('recovered')
    expect(reports[0]?.keptCount).toBe(2)
    expect(reports[0]?.rolledBack).toEqual(['3'])
    expect(await read(root, 'src/update.rs')).toBe('update base\n')
    const log = await runGit(['log', '--format=%B', '-1'], root)
    expect(log.stdout).toContain('(2/5 applied)')
    expect(log.stdout).toContain('skipped')
    expect(log.stdout).toContain('the driver process died during item 3')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('REFUSES when the rebuilt batch signal cannot satisfy its own contract', async () => {
  const { root } = await fixture({ duplicatePlanIds: true })
  try {
    const { reports, code } = await recoverProject(root, {
      commandRunner: GREEN,
      alive: DEAD,
    })
    expect(code).toBe(1)
    expect(reports[0]?.reason).toContain('배치 신호가 계약을 만족하지 않습니다')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('REFUSES when changed-file attribution is unavailable', async () => {
  const { root } = await fixture()
  try {
    const { reports, code } = await recoverProject(root, {
      commandRunner: GREEN,
      alive: DEAD,
      git: (args, cwd) =>
        args.includes('--porcelain=v1')
          ? Promise.resolve({ code: 1, stdout: '', stderr: 'status failed' })
          : runGit(args, cwd),
    })
    expect(code).toBe(1)
    expect(reports[0]?.reason).toContain('귀속을 읽을 수 없습니다')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('REFUSES when an unattributable file is present in the tree', async () => {
  const { root } = await fixture()
  try {
    await write(root, 'src/stray.rs', 'nobody claimed this\n')
    const { reports, code } = await recoverProject(root, {
      commandRunner: GREEN,
      alive: DEAD,
    })
    expect(code).toBe(1)
    expect(reports[0]?.reason).toContain('커밋 귀속을 증명할 수 없습니다')
    expect(reports[0]?.reason).toContain('src/stray.rs')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('REFUSES when the commit itself fails', async () => {
  const { root } = await fixture()
  try {
    const { reports, code } = await recoverProject(root, {
      commandRunner: GREEN,
      alive: DEAD,
      git: (args, cwd) =>
        args[0] === 'commit'
          ? Promise.resolve({ code: 128, stdout: '', stderr: 'commit blocked' })
          : runGit(args, cwd),
    })
    expect(code).toBe(1)
    expect(reports[0]?.reason).toContain('커밋하지 못했습니다')
    expect(reports[0]?.reason).toContain('commit blocked')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('a prefix that KEPT nothing is recovered without a commit', async () => {
  const { root } = await fixture({ revertAll: true })
  try {
    const { reports, code } = await recoverProject(root, {
      commandRunner: GREEN,
      alive: DEAD,
    })
    expect(code).toBe(0)
    expect(reports[0]?.status).toBe('recovered')
    expect(reports[0]?.keptCount).toBe(0)
    expect(reports[0]?.committed).toBe(false)
    expect(reports[0]?.lines.join('\n')).toContain('kept 아이템이 없어')
    expect(
      (await runGit(['rev-list', '--count', 'HEAD'], root)).stdout.trim(),
    ).toBe('1')
    expect((await runGit(['status', '--porcelain'], root)).stdout).toBe('')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('writeIterationRecord persists the baseline HEAD recover depends on', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'retry-now-record-'))
  try {
    const paths = resolvePaths(dir)
    await writeIterationRecord(paths, {
      iteration: ITERATION,
      baselineHead: 'c'.repeat(40),
      plannedCount: 5,
      scope: 'crates/core',
    })
    const record = JSON.parse(
      await readFile(paths.iterationRecord, 'utf8'),
    ) as Record<string, unknown>
    expect(record.iteration).toBe(ITERATION)
    expect(record.baselineHead).toBe('c'.repeat(40))
    expect(record.plannedCount).toBe(5)
    expect(record.scope).toBe('crates/core')
    expect(typeof record.startedAt).toBe('string')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
