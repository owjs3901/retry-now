/**
 * `retry-now recover` — reconstruct the correct state of a life whose driver was KILLED mid-batch.
 *
 * A 윤회 runs for hours or days inside a host process, so a host/editor restart is an ORDINARY event,
 * not an exceptional one. When it happens, items that already passed their independent review sit
 * UNCOMMITTED in the working tree while `state.json` still claims `running`. Start the next life and
 * those changes are absorbed into a fresh baseline: their provenance, evidence, and review verdict
 * are gone permanently, with no trace in history.
 *
 * This module performs, automatically, the recovery that otherwise has to be done by hand:
 *
 *  1. Refuse outright if a LIVE driver holds the lock (never race a running loop).
 *  2. Require the `running`/`interrupted` + dead-pid signature; anything else is already honest.
 *  3. Read the per-item review signals in item order to recover each item's FINAL verdict.
 *  4. Roll the first UNREVIEWED item back from its own backup — it never passed the review gate, so
 *     discipline says it must not survive. Because item K's backup is by construction
 *     `HEAD + item(1..K-1)`, restoring it strips EXACTLY item K, even when an earlier item touched
 *     the same file.
 *  5. Re-run the configured test/lint gate on the resulting tree.
 *  6. Prove attribution, then commit ONLY the reviewed-kept prefix.
 *  7. Make `state.json` honest and clear the consumed per-iteration artifacts.
 *
 * Every step FAILS CLOSED: anything this code cannot prove ends the run with `refused` and an
 * explanation, leaving the repository for a human. It commits reviewed work rather than discarding
 * it because a commit is reversible with `git reset` while a rollback destroys evidence permanently —
 * and unlike the in-process abort path, `recover` has no in-memory snapshot to prove a rollback with.
 */
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import { loadConfig } from './config.ts'
import {
  commitPaths,
  formatIterationCommitMessage,
  type GitRunner,
  headRevision,
  isGitRepo,
  runGit,
  statusPaths,
  statusPorcelain,
  validateCommitFileAttribution,
} from './git.ts'
import { writeCanonicalImproveBatch } from './improve-batch.ts'
import { validateImproveSignal } from './improve-signal.ts'
import { exists, nowIso, readJson, writeJson } from './io.ts'
import { SIGNAL_LIMITS } from './limits.ts'
import { isPidAlive, readDriverLock } from './lock.ts'
import {
  type ImproveItemPaths,
  pad,
  type Paths,
  resolveImproveItemPaths,
  resolvePaths,
  slugifyTarget,
} from './paths.ts'
import { verifyGatingCommands } from './preflight.ts'
import { dirEntries, restoreItemBackup } from './recover-backup.ts'
import { oneLine } from './safe-text.ts'
import { keptCountOf, keptFilesOf, normalizeSignal } from './signal.ts'
import { loadState, recordImproveOutcome, saveState } from './state.ts'
import type {
  CommandRunner,
  LoopState,
  PlannedImprovement,
  RetryNowConfig,
  Signal,
} from './types.ts'

/**
 * The in-flight IMPROVE transaction, written by the driver when a life's per-item work begins.
 * `baselineHead` is the single fact recovery cannot derive from anything else on disk.
 */
export interface IterationRecord {
  readonly iteration: number
  readonly baselineHead: string
  readonly plannedCount: number
  readonly scope: string
  readonly startedAt: string
}

function isIterationRecord(value: unknown): value is IterationRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<IterationRecord>
  return (
    typeof record.iteration === 'number' &&
    typeof record.baselineHead === 'string' &&
    typeof record.plannedCount === 'number'
  )
}

/** Record the IMPROVE transaction about to start, for a `recover` that may have to clean up after it. */
export async function writeIterationRecord(
  paths: Paths,
  record: Omit<IterationRecord, 'startedAt'>,
): Promise<void> {
  await writeJson(paths.iterationRecord, {
    ...record,
    startedAt: nowIso(),
  } satisfies IterationRecord)
}

export type RecoverStatus = 'clean' | 'recovered' | 'refused'

export interface RecoverReport {
  readonly status: RecoverStatus
  /** null for a whole-repo loop, else the target package path */
  readonly target: string | null
  readonly iteration: number | null
  /** items whose reviewed `kept` verdict was committed by this recovery */
  readonly keptCount: number
  readonly plannedCount: number
  /** ids of items rolled back because they never passed the review gate */
  readonly rolledBack: readonly string[]
  readonly committed: boolean
  readonly reason: string | null
  readonly lines: readonly string[]
}

export interface RecoverDeps {
  /**
   * Runs the configured test/lint gate. REQUIRED, and deliberately not defaulted: this module must
   * never create a child process itself, for the same reason `preflight.ts` does not — the commands
   * are the project's own test/lint, so a defaulted spawn would let the test suite re-enter itself
   * under the coverage instrumenter. Process creation stays in `loop-driver.ts`, which exports
   * `spawnVerifyCommand` for callers to wrap with `createCommandRunner`.
   */
  readonly commandRunner: CommandRunner
  readonly git?: GitRunner
  readonly alive?: (pid: number) => boolean
  readonly loadConfig?: (root: string) => Promise<RetryNowConfig | null>
}

type Ctx = {
  readonly root: string
  readonly target: string | null
  readonly scope: string
  readonly config: RetryNowConfig
  readonly paths: Paths
  readonly git: GitRunner
  readonly commandRunner: CommandRunner
  readonly alive: (pid: number) => boolean
  readonly lines: string[]
}

function refuse(
  ctx: Ctx,
  iteration: number | null,
  reason: string,
): RecoverReport {
  ctx.lines.push(`  ✗ 복구를 거부했습니다 — ${reason}`)
  ctx.lines.push(
    '  저장소는 그대로입니다. 위 내용을 확인한 뒤 직접 처리하세요.',
  )
  return {
    status: 'refused',
    target: ctx.target,
    iteration,
    keptCount: 0,
    plannedCount: 0,
    rolledBack: [],
    committed: false,
    reason,
    lines: ctx.lines,
  }
}

function clean(
  ctx: Ctx,
  iteration: number | null,
  note: string,
): RecoverReport {
  ctx.lines.push(`  · ${note}`)
  return {
    status: 'clean',
    target: ctx.target,
    iteration,
    keptCount: 0,
    plannedCount: 0,
    rolledBack: [],
    committed: false,
    reason: null,
    lines: ctx.lines,
  }
}

/** One planned item paired with the FINAL review verdict recovered from its own signal file. */
type ItemVerdict = {
  readonly index: number
  readonly item: PlannedImprovement
  readonly artifacts: ImproveItemPaths
  readonly review: Signal | null
}

async function readVerdicts(
  ctx: Ctx,
  iteration: number,
  planned: readonly PlannedImprovement[],
): Promise<ItemVerdict[]> {
  const verdicts: ItemVerdict[] = []
  for (const [index, item] of planned.entries()) {
    const artifacts = resolveImproveItemPaths(
      ctx.paths,
      iteration,
      index,
      'review',
      item.id,
    )
    const raw = normalizeSignal(await readJson<unknown>(artifacts.signal))
    // A review signal counts ONLY when it is a complete, valid, terminal verdict for THIS item.
    // Anything less is treated as "not reviewed", which is the conservative direction: the item gets
    // rolled back rather than silently committed on the strength of a half-written signal.
    const review =
      raw !== null &&
      raw.iteration === iteration &&
      raw.phase === 'improve' &&
      raw.result !== 'pending' &&
      validateImproveSignal(raw, [item]) === null
        ? { ...raw, report: artifacts.report }
        : null
    verdicts.push({ index, item, artifacts, review })
  }
  return verdicts
}

/**
 * Synthesise the outcome for an item that never reached a verdict, so the canonical batch signal
 * still accounts for EVERY planned item (the contract `validateImproveSignal` enforces).
 */
function unreviewedOutcome(
  iteration: number,
  item: PlannedImprovement,
  status: 'failed' | 'skipped',
  reason: string,
): Signal {
  const text = oneLine(reason, SIGNAL_LIMITS.decisionReason)
  return {
    iteration,
    phase: 'improve',
    result: 'failed',
    report: '(recover-generated)',
    plannedCount: 1,
    appliedImprovements: [
      {
        id: item.id,
        title: item.title,
        status,
        impact: oneLine(reason, SIGNAL_LIMITS.impact),
        decisionReason: text,
        files: [],
      },
    ],
    keptCount: 0,
    revertedCount: 0,
    failedCount: status === 'failed' ? 1 : 0,
    skippedCount: status === 'skipped' ? 1 : 0,
    summary: text,
    timestamp: nowIso(),
  }
}

/** Remove the artifacts a recovered iteration has consumed, so a rerun cannot re-read stale state. */
async function clearIterationArtifacts(
  paths: Paths,
  iteration: number,
): Promise<void> {
  const stateDir = resolve(paths.state, '..')
  await rm(paths.current, { force: true })
  await rm(paths.iterationRecord, { force: true })
  await rm(resolve(stateDir, 'backups', pad(iteration)), {
    recursive: true,
    force: true,
  })
  const itemsDir = resolve(stateDir, 'items')
  for (const entry of await dirEntries(itemsDir)) {
    if (!entry.startsWith(`${pad(iteration)}-`)) continue
    await rm(resolve(itemsDir, entry), { recursive: true, force: true })
  }
}

async function recoverIteration(ctx: Ctx): Promise<RecoverReport> {
  const stored = await readJson<Partial<LoopState>>(ctx.paths.state)
  if (stored === null || typeof stored.iteration !== 'number') {
    return clean(ctx, null, '이 대상은 아직 실행된 적이 없습니다.')
  }
  const status = stored.status ?? 'running'
  if (status !== 'running' && status !== 'interrupted') {
    return clean(
      ctx,
      stored.iteration,
      `status=${status} — 정직한 종료 상태입니다. 복구할 중단 흔적이 없습니다.`,
    )
  }

  const iteration = stored.iteration + 1
  const record = await readJson<unknown>(ctx.paths.iterationRecord)
  const residue = (await isGitRepo(ctx.root, ctx.git))
    ? await statusPorcelain(ctx.root, ctx.scope ? [ctx.scope] : [], ctx.git)
    : []

  if (!isIterationRecord(record) || record.iteration !== iteration) {
    if (residue.length === 0) {
      return clean(
        ctx,
        stored.iteration,
        '진행 중이던 IMPROVE 트랜잭션이 없고 워킹트리도 깨끗합니다.',
      )
    }
    return refuse(
      ctx,
      iteration,
      `생 ${iteration}의 IMPROVE 트랜잭션 기록(${ctx.paths.iterationRecord})이 없는데 워킹트리에 ${residue.length}건의 변경이 있습니다. 아이템 단위로 귀속할 근거가 없어 자동 복구할 수 없습니다`,
    )
  }

  ctx.lines.push(
    `  생 ${iteration} IMPROVE 트랜잭션이 중단된 채 남아 있습니다 (계획 ${record.plannedCount}건, 시작 ${record.startedAt}).`,
  )

  if (await exists(ctx.paths.headQuarantine)) {
    return refuse(
      ctx,
      iteration,
      `HEAD 격리(${ctx.paths.headQuarantine})가 활성 상태입니다. 먼저 HEAD를 복원하거나 retry-now reset으로 현재 상태를 명시적으로 수용하세요`,
    )
  }
  const currentHead = await headRevision(ctx.root, ctx.git)
  if (currentHead === null) {
    return refuse(ctx, iteration, 'Git HEAD를 읽을 수 없습니다')
  }
  if (currentHead !== record.baselineHead) {
    return refuse(
      ctx,
      iteration,
      `Git HEAD가 트랜잭션 시작(${record.baselineHead})에서 ${currentHead}로 바뀌었습니다. 이 생 도중에 커밋이 생겼다는 뜻이라 아이템 귀속을 신뢰할 수 없습니다`,
    )
  }

  const analyze = normalizeSignal(await readJson<unknown>(ctx.paths.signal))
  const planned = analyze?.plannedImprovements
  if (
    analyze === null ||
    analyze.iteration !== iteration ||
    analyze.phase !== 'analyze' ||
    planned === undefined ||
    planned.length !== record.plannedCount
  ) {
    return refuse(
      ctx,
      iteration,
      `생 ${iteration}의 권위 있는 ANALYZE 계획(${ctx.paths.signal})을 복원할 수 없습니다. 계획을 모르면 어떤 아이템이 미리뷰인지 판단할 수 없습니다`,
    )
  }

  const verdicts = await readVerdicts(ctx, iteration, planned)
  const boundary = verdicts.findIndex((entry) => entry.review === null)
  const reviewed = boundary === -1 ? verdicts : verdicts.slice(0, boundary)
  // A GAP (item 3 reviewed but item 2 not) means the on-disk verdicts are not a prefix of the plan,
  // so "everything before the boundary passed the gate" is not a claim this code may make.
  const gap = verdicts
    .slice(reviewed.length)
    .find((entry) => entry.review !== null)
  if (gap !== undefined) {
    return refuse(
      ctx,
      iteration,
      `리뷰 신호가 연속 prefix가 아닙니다: item ${gap.item.id}는 리뷰됐지만 그 앞 item이 리뷰되지 않았습니다. 아이템 순서 가정이 깨져 자동 복구할 수 없습니다`,
    )
  }
  for (const entry of reviewed) {
    const outcome = entry.review?.appliedImprovements?.[0]
    ctx.lines.push(
      `  · item ${entry.item.id}: 리뷰 판정 ${outcome?.status ?? 'unknown'} (복원)`,
    )
  }

  const rolledBack: string[] = []
  const unreviewed = verdicts[reviewed.length]
  if (unreviewed !== undefined) {
    const traces = await Promise.all([
      exists(unreviewed.artifacts.backupDir),
      exists(unreviewed.artifacts.report),
      exists(
        resolveImproveItemPaths(
          ctx.paths,
          iteration,
          unreviewed.index,
          'implement',
          unreviewed.item.id,
        ).signal,
      ),
    ])
    const [hasBackup, hasReport, hasImplementSignal] = traces
    if (!hasBackup && (hasReport || hasImplementSignal)) {
      return refuse(
        ctx,
        iteration,
        `미리뷰 item ${unreviewed.item.id}이 작업을 시작했는데 백업 디렉터리(${unreviewed.artifacts.backupDir})가 없습니다. 되돌릴 근거가 없어 롤백할 수 없습니다`,
      )
    }
    if (hasBackup) {
      const restored = await restoreItemBackup(
        ctx.root,
        unreviewed.artifacts,
        ctx.scope,
      )
      if (restored.issue !== null) {
        return refuse(
          ctx,
          iteration,
          `미리뷰 item ${unreviewed.item.id} 롤백 실패 — ${restored.issue}`,
        )
      }
      rolledBack.push(unreviewed.item.id)
      ctx.lines.push(
        `  · item ${unreviewed.item.id}: 미리뷰 — 백업에서 롤백했습니다 (복원 ${restored.restored.length}개 파일, 삭제 ${restored.deleted.length}개 신규 파일).`,
      )
    } else {
      ctx.lines.push(
        `  · item ${unreviewed.item.id}: 미리뷰 — 시작 흔적이 없어 되돌릴 것이 없습니다.`,
      )
    }
  }

  // `reviewed` is the slice before the first null review, so every entry carries one; narrowing it
  // by construction beats asserting it, so a later change to the slice boundary cannot lie here.
  const reviews: Signal[] = reviewed.flatMap((entry) =>
    entry.review === null ? [] : [entry.review],
  )
  for (const entry of verdicts.slice(reviewed.length)) {
    const isBoundary = entry.index === reviewed.length
    reviews.push(
      unreviewedOutcome(
        iteration,
        entry.item,
        isBoundary ? 'failed' : 'skipped',
        isBoundary
          ? `Driver process died before this item was independently reviewed; retry-now recover rolled it back from its backup because it never passed the review gate.`
          : `Not attempted: the driver process died during item ${planned[reviewed.length]?.id ?? '?'} of this batch.`,
      ),
    )
  }

  const improveSig = await writeCanonicalImproveBatch(
    ctx.paths,
    iteration,
    planned,
    reviews,
    `${pad(iteration)}-improve.md`,
  )
  const signalIssue = validateImproveSignal(improveSig, planned)
  if (signalIssue !== null) {
    return refuse(
      ctx,
      iteration,
      `복원한 배치 신호가 계약을 만족하지 않습니다 — ${signalIssue}`,
    )
  }

  // The per-item gate ran against each item's own tree, but the tree left after stripping the
  // unreviewed item's partial writes has never been verified as a whole. Prove it before committing.
  const verifyIssue = await verifyGatingCommands(
    ctx.root,
    ctx.config,
    ctx.commandRunner,
  )
  if (verifyIssue !== null) {
    return refuse(
      ctx,
      iteration,
      `롤백 후 검증이 실패했습니다 (${verifyIssue}). 리뷰를 통과한 변경은 워킹트리에 그대로 남겨 두었으며 커밋하지 않았습니다`,
    )
  }

  const keptFiles = keptFilesOf(improveSig)
  const keptCount = keptCountOf(improveSig)
  const currentDirty = await statusPaths(
    ctx.root,
    ctx.scope ? [ctx.scope] : [],
    ctx.git,
  )
  if (currentDirty === null) {
    return refuse(ctx, iteration, '현재 변경 파일 귀속을 읽을 수 없습니다')
  }
  // The baseline is EMPTY on purpose: `commitPerIteration` required a clean tree before IMPROVE
  // started, so after rolling back the unreviewed item the tree must contain exactly the reviewed
  // kept files and nothing else. Any extra path is unattributable work and stops the recovery.
  const attributionIssue = validateCommitFileAttribution(
    keptFiles,
    [],
    currentDirty,
    ctx.scope,
  )
  if (attributionIssue !== null) {
    return refuse(
      ctx,
      iteration,
      `커밋 귀속을 증명할 수 없습니다 — ${attributionIssue}`,
    )
  }

  let committed = false
  if (keptFiles.length > 0) {
    const message = `${formatIterationCommitMessage(pad(iteration), improveSig)}

Recovered by retry-now recover: the driver process died mid-batch, so this commit records the
items that had already passed independent review. ${
      rolledBack.length > 0
        ? `Item ${rolledBack.join(', ')} was rolled back from its per-item backup because it never reached a review verdict.`
        : 'No item needed rolling back.'
    }`
    const res = await commitPaths(ctx.root, keptFiles, message, ctx.git)
    if (res.code !== 0) {
      return refuse(
        ctx,
        iteration,
        `리뷰를 통과한 변경을 커밋하지 못했습니다 (git exit ${res.code}: ${oneLine(res.stderr, 200)})`,
      )
    }
    committed = true
    ctx.lines.push(
      `  ✓ 리뷰를 통과한 ${keptCount}/${planned.length}건을 ${keptFiles.length}개 파일로 커밋했습니다.`,
    )
  } else {
    ctx.lines.push('  · 리뷰를 통과한 kept 아이템이 없어 커밋하지 않았습니다.')
  }

  const state = await loadState(
    ctx.paths,
    ctx.config.threshold,
    ctx.config.revertThreshold,
  )
  recordImproveOutcome(state, keptCount)
  state.iteration = iteration
  state.status = 'interrupted'
  await saveState(ctx.paths, state)
  await clearIterationArtifacts(ctx.paths, iteration)
  ctx.lines.push(
    `  · state.json: iteration=${iteration} status=interrupted (다음 실행이 생 ${iteration + 1}부터 이어갑니다).`,
  )
  return {
    status: 'recovered',
    target: ctx.target,
    iteration,
    keptCount,
    plannedCount: planned.length,
    rolledBack,
    committed,
    reason: null,
    lines: ctx.lines,
  }
}

async function recoverTarget(
  root: string,
  target: string | null,
  config: RetryNowConfig,
  deps: RecoverDeps,
): Promise<RecoverReport> {
  const slug = target === null ? undefined : slugifyTarget(target)
  const ctx: Ctx = {
    root,
    target,
    scope: target ?? '',
    config,
    paths: resolvePaths(root, slug),
    git: deps.git ?? runGit,
    commandRunner: deps.commandRunner,
    alive: deps.alive ?? isPidAlive,
    lines: [`◆ ${target ?? '전체 레포'}`],
  }
  return recoverIteration(ctx)
}

/**
 * Recover every loop in a project. Refuses as a whole while a LIVE driver holds the project lock,
 * because recovery rewrites the exact state that driver is using.
 */
export async function recoverProject(
  root: string,
  deps: RecoverDeps,
): Promise<{
  readonly reports: readonly RecoverReport[]
  readonly code: number
}> {
  const config = await (deps.loadConfig ?? loadConfig)(root)
  if (config === null) {
    return {
      reports: [
        {
          status: 'refused',
          target: null,
          iteration: null,
          keptCount: 0,
          plannedCount: 0,
          rolledBack: [],
          committed: false,
          reason: '.retry-now/config.json 이 없거나 유효하지 않습니다',
          lines: [
            '✗ .retry-now/config.json 이 없거나 유효하지 않습니다. 먼저 `retry-now init`.',
          ],
        },
      ],
      code: 1,
    }
  }

  const paths = resolvePaths(root)
  const holder = await readDriverLock(paths.driverLock)
  const alive = deps.alive ?? isPidAlive
  if (holder !== null && holder.pid !== process.pid && alive(holder.pid)) {
    return {
      reports: [
        {
          status: 'refused',
          target: null,
          iteration: null,
          keptCount: 0,
          plannedCount: 0,
          rolledBack: [],
          committed: false,
          reason: `살아 있는 드라이버(pid ${holder.pid})가 실행 중입니다`,
          lines: [
            `✗ 이 프로젝트에서 드라이버가 아직 돌고 있습니다 (pid ${holder.pid}, 시작 ${holder.startedAt}).`,
            '  먼저 `.retry-now/STOP` 으로 정지시킨 뒤 다시 복구하세요. 실행 중인 루프의 상태를 고쳐 쓰지 않습니다.',
          ],
        },
      ],
      code: 1,
    }
  }

  const targets: (string | null)[] =
    config.targets.length === 0 ? [null] : [...config.targets]
  const reports: RecoverReport[] = []
  for (const target of targets) {
    reports.push(await recoverTarget(root, target, config, deps))
  }
  // The stale lock is the LAST thing removed: while it exists, a driver launched mid-recovery would
  // still be refused, and every earlier `refused` path deliberately leaves it in place.
  if (
    holder !== null &&
    reports.every((report) => report.status !== 'refused')
  ) {
    await rm(paths.driverLock, { force: true })
  }
  return {
    reports,
    code: reports.some((report) => report.status === 'refused') ? 1 : 0,
  }
}
