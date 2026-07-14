/**
 * The loop driver — 윤회를 돌리는 자.
 *
 * Sole owner of the cross-life control state (the consecutive no-improvement streak). Each
 * phase spawns a FRESH agent session (context reset to 0) and injects NO prior results, so a
 * fresh ANALYZE cannot be biased by past conclusions. Stops when:
 *   - ANALYZE returns `no_improvements` for `threshold` consecutive lives → converged (맺어짐)
 *   - the safety cap `maxIterations` is reached
 *   - a `.retry-now/STOP` sentinel appears (manual; state persists, rerun to resume)
 *   - an agent fails to emit a valid signal twice in a row → error
 *
 * Monorepo (분할) mode: when `config.targets` is non-empty, the driver runs an INDEPENDENT loop
 * per target — each with its own state/reports/ledger/summary under `.retry-now/targets/<slug>/`
 * and prompts scoped to that package — then writes an overall summary at the root.
 */
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import {
  AGENT_LABEL,
  agentForRole,
  buildAgentCommand,
  modelForPhase,
  modelForRole,
} from './agents.ts'
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
import { runImproveBatch } from './improve-runner.ts'
import { createImproveStageExecutor } from './improve-stage.ts'
import {
  appendLine,
  ensureDir,
  exists,
  nowIso,
  readJson,
  readText,
  writeJson,
  writeText,
} from './io.ts'
import { acquireDriverLock, releaseDriverLock } from './lock.ts'
import { DIR, pad, type Paths, resolvePaths, slugifyTarget } from './paths.ts'
import { quotaExhaustedInLog } from './quota.ts'
import {
  guardAnalyzeRepository,
  rollbackIterationRepository,
} from './repository-guard.ts'
import { captureRepositorySnapshot } from './repository-snapshot.ts'
import { LEDGER_HEADER, scaffold, writePrompts } from './scaffold.ts'
import {
  beginPhase,
  keptCountOf,
  keptFilesOf,
  readSignal,
  validateImproveSignal,
} from './signal.ts'
import {
  loadState,
  recordImproveOutcome,
  recordNoImprovement,
  saveState,
} from './state.ts'
import { BANNER, converged, rebirth, revertConverged } from './theme.ts'
import type {
  AgentRole,
  DriverOptions,
  ImproveStage,
  LoopState,
  Phase,
  PlannedImprovement,
  RetryNowConfig,
  Signal,
} from './types.ts'

function composeMessage(
  iter: number,
  phase: Phase,
  stateDirRel: string,
  scope: string,
): string {
  const padded = pad(iter)
  const scopeHint = scope
    ? ` SCOPE: restrict ALL analysis and changes strictly to the path "${scope}".`
    : ''
  return (
    `retry-now reincarnation. Iteration ${iter}, phase ${phase.toUpperCase()} (id ${padded}). ` +
    `You are a FRESH session with NO memory of any prior life.${scopeHint} ` +
    `Read and obey ${stateDirRel}/prompts/${phase}.md EXACTLY. ` +
    `Your FINAL action MUST be overwriting ${stateDirRel}/signal.json exactly as that file specifies.`
  )
}

/** Spawn an agent CLI, tee its output to a log file, resolve with the exit code. */
export function runAgent(
  cmd: string,
  args: readonly string[],
  cwd: string,
  logPath: string,
  log: (line: string) => void,
): Promise<number> {
  return new Promise((resolve) => {
    const out = createWriteStream(logPath, { flags: 'w' })
    let settled = false
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      out.end(() => resolve(code))
    }
    const child = spawn(cmd, [...args], {
      cwd,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    // Send an immediate EOF on stdin: headless agents must not block waiting for input, and a
    // closed pipe is more robust on Windows than mapping stdin to the NUL device ('ignore').
    child.stdin?.end()
    child.stdout.on('data', (d: Buffer) => out.write(d))
    child.stderr.on('data', (d: Buffer) => out.write(d))
    child.on('error', (err) => {
      log(`  ! spawn failed: ${err.message}`)
      finish(-1)
    })
    child.on('close', (code) => {
      finish(code ?? -1)
    })
  })
}

/** Synthetic signal used by --dry-run to exercise the full control flow without an agent. */
function synthSignal(
  iter: number,
  phase: Phase,
  plannedCount = 1,
  item?: PlannedImprovement,
  report = '(dry-run)',
): Signal {
  if (phase === 'analyze') {
    const found = iter === 1 // life 1 finds one improvement; later lives find none → converge
    return {
      iteration: iter,
      phase,
      result: found ? 'improvements_found' : 'no_improvements',
      report: `(dry-run)`,
      nextImprovement: found ? '(dry-run improvement)' : '',
      plannedImprovements: found
        ? Array.from({ length: plannedCount }, (_, index) => ({
            id: String(index + 1),
            title: `(dry-run improvement ${index + 1})`,
            risk: 'low' as const,
          }))
        : [],
      summary: '(dry-run)',
      timestamp: nowIso(),
    }
  }
  return {
    iteration: iter,
    phase,
    result: 'applied',
    report,
    appliedImprovements: [
      {
        id: item?.id ?? '1',
        title: item?.title ?? '(dry-run improvement)',
        status: 'kept',
        impact: '(dry-run impact)',
        decisionReason: '(dry-run verification passed)',
        files: [`dry-run-${item?.id ?? '1'}.txt`],
      },
    ],
    plannedCount: 1,
    keptCount: 1,
    revertedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    metricDelta: '(dry-run)',
    summary: '(dry-run)',
    timestamp: nowIso(),
  }
}

type PhaseInvocation = {
  readonly role: AgentRole
  readonly message: string
  readonly logPath: string
  readonly item?: PlannedImprovement
  readonly stage?: ImproveStage
  readonly reportPath?: string
}

async function runPhase(
  paths: Paths,
  config: RetryNowConfig,
  iter: number,
  phase: Phase,
  opts: DriverOptions,
  log: (line: string) => void,
  stateDirRel: string,
  scope: string,
  invocation?: PhaseInvocation,
): Promise<Signal | null> {
  await beginPhase(
    paths,
    iter,
    phase,
    scope,
    invocation?.item && invocation.stage
      ? { id: invocation.item.id, stage: invocation.stage }
      : undefined,
  )

  if (opts.dryRun) {
    const synthetic = synthSignal(
      iter,
      phase,
      config.improvementBatchSize,
      invocation?.item,
      invocation?.reportPath,
    )
    if (invocation?.reportPath) {
      await writeText(
        invocation.reportPath,
        `(dry-run ${invocation.stage} report)\n`,
      )
    }
    if (invocation?.logPath) await writeText(invocation.logPath, '')
    await writeJson(paths.signal, synthetic)
  } else {
    const role = invocation?.role ?? phase
    const { cmd, args } = buildAgentCommand(
      config,
      invocation?.message ?? composeMessage(iter, phase, stateDirRel, scope),
      role,
    )
    const logPath =
      invocation?.logPath ??
      join(paths.logsDir, `iter-${pad(iter)}-${phase}.log`)
    const model = modelForRole(config, role) || 'agent default'
    log(
      `  ↳ ${AGENT_LABEL[agentForRole(config, role)]} ${invocation?.stage ?? phase} (${model}, fresh session)…`,
    )
    const code = await runAgent(cmd, args, paths.root, logPath, log)
    if (code !== 0) log(`  ! agent exited with code ${code} (see ${logPath})`)
  }

  return readSignal(paths, iter, phase)
}

const PHASE_ATTEMPTS = 3

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Actionable guidance shown when an agent fails to produce a valid signal (likely a crash). */
function logCrashGuidance(
  log: (line: string) => void,
  config: RetryNowConfig,
  paths: Paths,
): void {
  log(
    `  에이전트(${AGENT_LABEL[config.agent]})가 유효한 신호를 내지 못했습니다 — 크래시(예: Bun segfault)일 수 있습니다.`,
  )
  log(`  • 로그 확인: ${paths.logsDir}`)
  log(
    `  • 다시 \`retry-now run\` 하면 마지막 상태부터 이어집니다(매 생은 컨텍스트 0이라 재시도가 안전).`,
  )
  log(
    `  • 계속 크래시하면 config의 agent를 codex/claude로 바꾸거나 opencode/bun을 업데이트하세요.`,
  )
  log(
    `  • opencode 안에서 /retry-now로 중첩 실행하기보다 별도 터미널의 \`retry-now run\`이 더 안정적입니다.`,
  )
}

/**
 * Outcome of a resilient phase run:
 *   - `ok`     — the agent emitted a valid signal (carried here).
 *   - `quota`  — every account is out of quota (429 / rate-limit); the loop should PAUSE, not
 *                treat this as a crash (retrying would just burn the next account too).
 *   - `failed` — a genuine no-signal (likely a crash) after exhausting the retry budget.
 */
type PhaseOutcome =
  | { readonly kind: 'ok'; readonly signal: Signal }
  | { readonly kind: 'quota' }
  | { readonly kind: 'failed' }

/** Compact human duration for wait/pause logs: 90000 -> "2m", 21600000 -> "6.0h". */
function fmtDuration(ms: number): string {
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 1000)}s`
}

/** Guidance shown when the loop pauses because every account is out of quota (NOT a crash). */
function logQuotaGuidance(
  log: (line: string) => void,
  config: RetryNowConfig,
  paths: Paths,
): void {
  log(
    `  모든 계정의 쿼터가 소진되었습니다(429/rate-limit) — 재시도가 무의미하여 멈춥니다(크래시 아님).`,
  )
  log(
    `  • 완료된 이전 윤회는 안전합니다. 중단된 현재 윤회는 시작 상태로 복원되었으며 재실행 시 처음부터 다시 시도합니다.`,
  )
  log(`  • 로그 확인: ${paths.logsDir}`)
  if (!config.waitForQuota) {
    log(
      `  • 자동 대기·재개를 원하면 config의 \`waitForQuota: true\` 또는 \`--wait-for-quota\` 플래그.`,
    )
  }
}

type HeadQuarantine = {
  readonly expectedHead: string
  readonly actualHead: string
  readonly iteration: number
  readonly source: 'analyze' | 'implement' | 'review' | 'batch'
  readonly itemId?: string
  readonly createdAt: string
}

function isHeadQuarantine(value: unknown): value is HeadQuarantine {
  if (typeof value !== 'object' || value === null) return false
  return (
    'expectedHead' in value &&
    typeof value.expectedHead === 'string' &&
    'actualHead' in value &&
    typeof value.actualHead === 'string'
  )
}

async function quarantineHeadChange(
  paths: Paths,
  quarantine: Omit<HeadQuarantine, 'createdAt'>,
): Promise<void> {
  await writeJson(paths.headQuarantine, {
    ...quarantine,
    createdAt: nowIso(),
  } satisfies HeadQuarantine)
}

async function headQuarantineReason(paths: Paths): Promise<string | null> {
  if (!(await exists(paths.headQuarantine))) return null
  const quarantine = await readJson<unknown>(paths.headQuarantine)
  if (!isHeadQuarantine(quarantine)) {
    return `HEAD quarantine is unreadable: ${paths.headQuarantine}. Run retry-now reset only after inspecting the repository.`
  }
  const currentHead = await headRevision(paths.root)
  if (currentHead === quarantine.expectedHead) {
    await rm(paths.headQuarantine, { force: true })
    return null
  }
  return `unauthorized Git HEAD remains quarantined (expected ${quarantine.expectedHead}, current ${currentHead ?? '(unavailable)'}). Restore the expected HEAD or run retry-now reset to explicitly accept the current repository state.`
}

/** Apply the terminal status + guidance for a non-`ok` phase outcome (quota pause vs crash). */
function handlePhaseStop(
  state: LoopState,
  kind: 'quota' | 'failed',
  label: string,
  iter: number,
  phase: Phase,
  config: RetryNowConfig,
  paths: Paths,
  log: (line: string) => void,
): void {
  if (kind === 'quota') {
    log(
      `[${label}][${iter}] ${phase}: 모든 계정 쿼터 소진 → paused-quota 정지(쿼터가 차면 재실행으로 재개).`,
    )
    logQuotaGuidance(log, config, paths)
    state.status = 'paused-quota'
    return
  }
  log(
    `[${label}][${iter}] ${phase}: ${PHASE_ATTEMPTS}회 시도 모두 유효한 신호 없음 → error 정지.`,
  )
  logCrashGuidance(log, config, paths)
  state.status = 'error'
}

/**
 * Run a phase, classifying a no-signal run into three outcomes (see `PhaseOutcome`). A crash is
 * retried in a fresh session (each life is context-0, so a retry is always safe). An
 * all-accounts-out-of-quota failure is NOT a crash: with `waitForQuota` the driver waits for the
 * quota to refill (polling every `quotaPollMs`, capped at `maxQuotaWaitMs`, abortable via the
 * STOP sentinel) and retries the SAME life WITHOUT spending the crash-retry budget; otherwise it
 * returns `quota` so the loop pauses cleanly instead of stopping with a misleading `error`.
 */
async function runPhaseResilient(
  paths: Paths,
  config: RetryNowConfig,
  iter: number,
  phase: Phase,
  opts: DriverOptions,
  log: (line: string) => void,
  stateDirRel: string,
  scope: string,
  validate?: (signal: Signal) => string | null,
  retryGuard?: () => Promise<string | null>,
  invocation?: PhaseInvocation,
): Promise<PhaseOutcome> {
  const logPath =
    invocation?.logPath ?? join(paths.logsDir, `iter-${pad(iter)}-${phase}.log`)
  const waitDeadline = Date.now() + config.maxQuotaWaitMs
  let attempt = 0
  while (attempt < PHASE_ATTEMPTS) {
    attempt++
    const sig = await runPhase(
      paths,
      config,
      iter,
      phase,
      opts,
      log,
      stateDirRel,
      scope,
      invocation,
    )
    if (sig) {
      const issue = validate?.(sig) ?? null
      if (issue === null) return { kind: 'ok', signal: sig }
      log(
        `  ! ${phase}: invalid structured signal (attempt ${attempt}/${PHASE_ATTEMPTS}) — ${issue}`,
      )
    }

    // A no-signal run looks like a crash by exit code, but an out-of-quota wall needs the
    // opposite handling. Check the agent's own log for a rate-limit / quota error shape.
    if (!opts.dryRun && (await quotaExhaustedInLog(logPath))) {
      if (!opts.waitForQuota) return { kind: 'quota' }
      if (await exists(paths.stop)) return { kind: 'quota' }
      if (Date.now() >= waitDeadline) {
        log(
          `  ⏳ ${phase}: 쿼터가 ${fmtDuration(config.maxQuotaWaitMs)} 동안 회복되지 않음 → paused-quota.`,
        )
        return { kind: 'quota' }
      }
      log(
        `  ⏳ ${phase}: 모든 계정 쿼터 소진 — ${fmtDuration(config.quotaPollMs)} 대기 후 재시도(쿼터 충전 대기)…`,
      )
      const retryIssue = (await retryGuard?.()) ?? null
      if (retryIssue !== null) {
        log(`  ! ${phase}: refusing unsafe retry — ${retryIssue}`)
        return { kind: 'failed' }
      }
      await delay(config.quotaPollMs)
      attempt-- // a quota wait is not a crash attempt — retry this life without spending budget
      continue
    }

    if (attempt < PHASE_ATTEMPTS) {
      const retryIssue = (await retryGuard?.()) ?? null
      if (retryIssue !== null) {
        log(`  ! ${phase}: refusing unsafe retry — ${retryIssue}`)
        return { kind: 'failed' }
      }
      log(
        `  ! ${phase}: no valid signal (attempt ${attempt}/${PHASE_ATTEMPTS}) — the agent may have crashed. Retrying in a fresh session…`,
      )
      await delay(2000)
    }
  }
  return { kind: 'failed' }
}

async function appendHistory(
  paths: Paths,
  config: RetryNowConfig,
  iter: number,
  phase: Phase,
  sig: Signal,
): Promise<void> {
  const role: AgentRole = phase === 'analyze' ? 'analyze' : 'review'
  await appendLine(
    paths.history,
    JSON.stringify({
      at: nowIso(),
      iteration: iter,
      phase,
      result: sig.result,
      agent: agentForRole(config, role),
      model: modelForRole(config, role) || 'agent default',
      summary: sig.summary,
      report: sig.report,
      ...(sig.nextImprovement ? { nextImprovement: sig.nextImprovement } : {}),
      ...(sig.metricDelta ? { metricDelta: sig.metricDelta } : {}),
      ...(sig.plannedImprovements
        ? { plannedCount: sig.plannedImprovements.length }
        : typeof sig.plannedCount === 'number'
          ? { plannedCount: sig.plannedCount }
          : {}),
      ...(typeof sig.keptCount === 'number'
        ? { keptCount: sig.keptCount }
        : {}),
      ...(typeof sig.revertedCount === 'number'
        ? { revertedCount: sig.revertedCount }
        : {}),
      ...(typeof sig.failedCount === 'number'
        ? { failedCount: sig.failedCount }
        : {}),
      ...(typeof sig.skippedCount === 'number'
        ? { skippedCount: sig.skippedCount }
        : {}),
      ...(sig.appliedImprovements
        ? { appliedImprovements: sig.appliedImprovements }
        : {}),
    }),
  )
}

interface HistoryEntry {
  at?: string
  iteration: number
  phase: Phase
  result: string
  summary?: string
  report?: string
  nextImprovement?: string
  metricDelta?: string
  plannedCount?: number
  keptCount?: number
  revertedCount?: number
  failedCount?: number
  skippedCount?: number
  agent?: string
  model?: string
  appliedImprovements?: Signal['appliedImprovements']
}

function escCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 100)
}

/** Compose a single loop's comprehensive report (summary.md) from its history. */
async function writeSummary(
  paths: Paths,
  state: LoopState,
  config: RetryNowConfig,
  target?: string,
  residue: readonly string[] = [],
): Promise<void> {
  const raw = (await readText(paths.history)) ?? ''
  const entries: HistoryEntry[] = []
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    try {
      entries.push(JSON.parse(t) as HistoryEntry)
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err
    }
  }
  const improves = entries.filter((e) => e.phase === 'improve')
  const applied = improves.filter((e) => e.result === 'applied')
  const reverted = improves.filter(
    (e) => e.result === 'applied_reverted',
  ).length
  const failed = improves.filter((e) => e.result === 'failed').length
  const analyzeNo = entries.filter(
    (e) => e.phase === 'analyze' && e.result === 'no_improvements',
  ).length
  const analyzeYes = entries.filter(
    (e) => e.phase === 'analyze' && e.result === 'improvements_found',
  ).length
  const plannedTotal = entries
    .filter((e) => e.phase === 'analyze')
    .reduce((sum, e) => sum + (e.plannedCount ?? 0), 0)
  const itemKept = improves.reduce((sum, e) => sum + (e.keptCount ?? 0), 0)
  const itemReverted = improves.reduce(
    (sum, e) => sum + (e.revertedCount ?? 0),
    0,
  )
  const itemFailed = improves.reduce((sum, e) => sum + (e.failedCount ?? 0), 0)
  const itemSkipped = improves.reduce(
    (sum, e) => sum + (e.skippedCount ?? 0),
    0,
  )

  const out: string[] = [
    target
      ? `# retry-now — 윤회 종합 보고서: ${target}`
      : '# retry-now — 윤회 종합 보고서 (summary)',
    '',
    ...(target ? [`- target: \`${target}\``] : []),
    `- status: **${state.status}**`,
    `- iterations: ${state.iteration}`,
    `- final streak: ${state.noImprovementStreak}/${config.threshold}`,
    `- final revert-streak: ${state.revertStreak}/${config.revertThreshold}`,
    `- analyze agent/model: ${agentForRole(config, 'analyze')} / ${modelForRole(config, 'analyze') || 'agent default'}`,
    `- implement agent/model: ${agentForRole(config, 'improve')} / ${modelForRole(config, 'improve') || 'agent default'}`,
    `- review agent/model: ${agentForRole(config, 'review')} / ${modelForRole(config, 'review') || 'agent default'}`,
    `- commit-per-iteration: ${config.commitPerIteration ? 'on' : 'off'}`,
    `- started: ${state.startedAt}`,
    `- ended: ${state.updatedAt}`,
    '',
    '## 집계',
    `- analyze: 개선발견 ${analyzeYes} · 개선없음 ${analyzeNo}`,
    `- improve: applied ${applied.length} · reverted ${reverted} · failed ${failed}`,
    `- planned improvements: ${plannedTotal}`,
    `- item outcomes: 적용/성공(kept, 더 나아짐) ${itemKept} · reverted ${itemReverted} · failed ${itemFailed} · skipped ${itemSkipped}`,
    '',
  ]

  if (residue.length > 0) {
    out.push(
      '## ⚠ 미정리 변경 (커밋/리버트 안 됨 — 검토 필요)',
      '',
      '루프 종료 시 워킹트리에 남아 있던 변경입니다. 개선으로 커밋되지도, 회귀로 리버트되지도 않았습니다.',
      '',
      '```',
      ...residue.slice(0, 50),
      ...(residue.length > 50 ? [`… (+${residue.length - 50} more)`] : []),
      '```',
      '',
    )
  }

  const itemRows = improves.flatMap((e) =>
    (e.appliedImprovements ?? []).map((item) => ({ entry: e, item })),
  )
  if (itemRows.length > 0) {
    out.push(
      '## 개선사항별 결과와 이유',
      '',
      '| iter | id | status | model | improvement | reason |',
      '|---|---|---|---|---|---|',
    )
    for (const row of itemRows) {
      out.push(
        `| ${pad(row.entry.iteration)} | ${escCell(row.item.id)} | ${row.item.status} | ${escCell(row.entry.model ?? 'agent default')} | ${escCell(row.item.title)} | ${escCell(row.item.summary ?? row.item.metricDelta ?? '-')} |`,
      )
    }
    out.push('')
  }

  if (applied.length > 0) {
    out.push('## 적용된 개선 (KEEP)')
    for (const e of applied) {
      const counts =
        typeof e.keptCount === 'number'
          ? ` (kept ${e.keptCount}${e.revertedCount ? `, reverted ${e.revertedCount}` : ''})`
          : ''
      out.push(
        `- [${pad(e.iteration)}] ${escCell(e.summary ?? '')}${counts}${e.metricDelta ? ` — \`${escCell(e.metricDelta)}\`` : ''}`,
      )
    }
    out.push('')
  }

  out.push(
    '## 이터레이션 로그',
    '',
    '| iter | phase | result | note |',
    '|---|---|---|---|',
  )
  for (const e of entries) {
    const note =
      e.phase === 'analyze'
        ? (e.nextImprovement ?? e.summary ?? '')
        : (e.metricDelta ?? e.summary ?? '')
    out.push(
      `| ${pad(e.iteration)} | ${e.phase} | ${e.result} | ${escCell(note)} |`,
    )
  }
  out.push(
    '',
    `상세: \`${paths.reportsDir}\`, \`${paths.ledger}\`, \`${paths.history}\``,
    '',
  )

  await writeText(paths.summary, out.join('\n'))
}

/** Aggregate per-target results into the root summary.md (per-package mode). */
async function writeOverallSummary(
  root: string,
  config: RetryNowConfig,
  results: readonly { target: string; result: DriverResult }[],
): Promise<void> {
  const paths = resolvePaths(root)
  const out: string[] = [
    '# retry-now — 전체 윤회 종합 보고서 (overall)',
    '',
    `- mode: per-package (분할 윤회) — ${results.length} target(s)`,
    `- analyze agent/model: ${config.agent} / ${modelForPhase(config, 'analyze') || 'agent default'}`,
    `- improve agent/model: ${config.agent} / ${modelForPhase(config, 'improve') || 'agent default'}`,
    `- threshold: ${config.threshold}`,
    '',
    '## 타겟별 결과',
    '',
    '| target | status | iterations | streak |',
    '|---|---|---|---|',
  ]
  for (const r of results) {
    out.push(
      `| ${escCell(r.target)} | ${r.result.status} | ${r.result.iterations} | ${r.result.finalStreak}/${r.result.threshold} |`,
    )
  }
  out.push('', `각 타겟 상세 보고서: \`${DIR}/targets/<slug>/summary.md\``, '')
  await writeText(paths.summary, out.join('\n'))
}

export interface DriverResult {
  readonly status: LoopState['status']
  readonly iterations: number
  readonly finalStreak: number
  readonly threshold: number
}

/**
 * Commit one completed batch from its structured signal. The driver owns commit creation so every
 * normal and signing-retry path uses the same applied/planned count and per-item evidence. It stages
 * ONLY files the signal names as kept (never a blanket `git add -A`), so unrelated changes are not
 * swept in. Git failure is best-effort and never fatal; the loop must not wedge while unattended.
 */
async function reconcileKeptCommit(
  paths: Paths,
  config: RetryNowConfig,
  iter: number,
  sig: Signal,
  baselineDirty: readonly string[] | null,
  scope: string,
  log: (line: string) => void,
  git: GitRunner = runGit,
): Promise<void> {
  if (!config.commitPerIteration) return
  if (keptCountOf(sig) === 0) return
  const files = keptFilesOf(sig)
  // No attributable files → committing safely is impossible; the end-of-loop check will surface it.
  if (files.length === 0) return
  if (!(await isGitRepo(paths.root, git))) return
  if (baselineDirty === null) {
    log('  ! commit: could not establish the pre-IMPROVE dirty-file baseline.')
    return
  }
  const currentDirty = await statusPaths(paths.root, scope ? [scope] : [], git)
  if (currentDirty === null) {
    log('  ! commit: could not establish exact changed-file attribution.')
    return
  }
  const attributionIssue = validateCommitFileAttribution(
    files,
    baselineDirty,
    currentDirty,
    scope,
  )
  if (attributionIssue !== null) {
    log(`  ! commit: unsafe attribution — ${attributionIssue}`)
    return
  }
  const dirty = await statusPorcelain(paths.root, files, git)
  if (dirty.length === 0) return
  const message = formatIterationCommitMessage(pad(iter), sig)
  const res = await commitPaths(paths.root, files, message, git)
  if (res.code === 0) {
    log(
      `  ✓ commit: recorded ${keptCountOf(sig)}/${sig.plannedCount ?? sig.appliedImprovements?.length ?? keptCountOf(sig)} applied item(s) across ${files.length} file(s).`,
    )
  } else {
    log(
      `  ! commit: could not record kept files (git exit ${res.code}) — left in the working tree for review.`,
    )
  }
}

/**
 * The working-tree changes still present when a loop settles. The invariant is that a finished
 * loop leaves a CLEAN tree (every life either committed its kept changes or reverted everything
 * else), so anything here is residue to SURFACE — never to auto-discard (unrelated user changes
 * must never be clobbered). Scoped to `scope` in per-package mode; `.retry-now/` is gitignored and
 * never appears. A non-repo project yields an empty list.
 */
async function residualWorkingTree(
  root: string,
  scope: string,
  git: GitRunner = runGit,
): Promise<string[]> {
  if (!(await isGitRepo(root, git))) return []
  return statusPorcelain(root, scope ? [scope] : [], git)
}

/** Run ONE independent loop (whole-repo when target is null, else scoped to the target path). */
async function runOneLoop(
  root: string,
  target: string | null,
  config: RetryNowConfig,
  opts: DriverOptions,
  log: (line: string) => void,
): Promise<DriverResult> {
  const slug = target !== null ? slugifyTarget(target) : undefined
  const stateDirRel = target !== null ? `${DIR}/targets/${slug}` : DIR
  const scope = target ?? ''
  const paths = resolvePaths(root, slug)
  const label = target ?? 'repo'

  await ensureDir(paths.reportsDir)
  await ensureDir(paths.logsDir)
  await writePrompts(paths, config, stateDirRel, scope) // (re)generate scoped prompts for this loop
  if (!(await exists(paths.ledger)))
    await writeText(paths.ledger, LEDGER_HEADER)

  const state = await loadState(paths, config.threshold, config.revertThreshold)

  const quarantineReason = await headQuarantineReason(paths)
  if (quarantineReason !== null) {
    state.status = 'error'
    await saveState(paths, state)
    log(`[${label}] ${quarantineReason}`)
    return {
      status: state.status,
      iterations: state.iteration,
      finalStreak: state.noImprovementStreak,
      threshold: state.threshold,
    }
  }

  if (state.status.startsWith('stopped')) {
    log(
      `[${label}] 이미 '${state.status}'. 리셋하려면 ${stateDirRel}/state.json 을 삭제.`,
    )
    return {
      status: state.status,
      iterations: state.iteration,
      finalStreak: state.noImprovementStreak,
      threshold: state.threshold,
    }
  }

  // Reaching here means the loop is active again — a fresh start, or a resume from a recoverable
  // stop (`paused-quota` / `error` / a process killed mid-life). Reflect that so a mid-run
  // snapshot of state.json reads `running`, not the stale pause/error it resumed from.
  state.status = 'running'

  while (true) {
    if (await exists(paths.stop)) {
      log(`[${label}] STOP 감지(.retry-now/STOP). 정지.`)
      state.status = 'stopped-manual'
      break
    }
    if (state.noImprovementStreak >= config.threshold) {
      log(`[${label}] ${converged(config.threshold)}`)
      state.status = 'stopped-converged'
      break
    }
    if (state.revertStreak >= config.revertThreshold) {
      log(`[${label}] ${revertConverged(config.revertThreshold)}`)
      state.status = 'stopped-converged'
      break
    }
    if (state.iteration >= config.maxIterations) {
      log(
        `[${label}] MaxIterations(${config.maxIterations}) 도달 → 정지(안전 상한).`,
      )
      state.status = 'stopped-maxiter'
      break
    }

    const iter = state.iteration + 1
    log('─'.repeat(56))
    log(`${rebirth(iter)}${target ? ` · ${target}` : ''}`)

    const analyzeSnapshot = opts.dryRun
      ? null
      : await captureRepositorySnapshot(paths.root)
    if (!opts.dryRun && analyzeSnapshot === null) {
      state.status = 'error'
      log(
        `[${label}][${iter}] ANALYZE 시작 전 Git-visible 저장소 스냅샷을 만들 수 없습니다. 충돌 상태 또는 서브모듈을 확인하세요.`,
      )
      break
    }
    const a = await runPhaseResilient(
      paths,
      config,
      iter,
      'analyze',
      opts,
      log,
      stateDirRel,
      scope,
    )
    if (analyzeSnapshot !== null) {
      const analyzeGuard = await guardAnalyzeRepository(
        paths.root,
        analyzeSnapshot,
      )
      if (analyzeGuard.kind === 'head-changed') {
        await quarantineHeadChange(paths, {
          expectedHead: analyzeGuard.expectedHead,
          actualHead: analyzeGuard.actualHead,
          iteration: iter,
          source: 'analyze',
        })
        state.status = 'error'
        log(
          `[${label}][${iter}] ANALYZE가 Git HEAD를 변경했습니다. 자동 reset 없이 격리했습니다.`,
        )
        break
      }
      if (analyzeGuard.kind === 'restored' || analyzeGuard.kind === 'failed') {
        state.status = 'error'
        log(
          analyzeGuard.kind === 'restored'
            ? `[${label}][${iter}] ANALYZE가 저장소를 변경하여 시작 상태로 복원하고 중단했습니다.`
            : `[${label}][${iter}] ANALYZE 변경 복원 실패 — ${analyzeGuard.issue}`,
        )
        break
      }
    }
    if (a.kind !== 'ok') {
      handlePhaseStop(state, a.kind, label, iter, 'analyze', config, paths, log)
      break
    }
    const analyzeSig = a.signal
    await appendHistory(paths, config, iter, 'analyze', analyzeSig)

    if (analyzeSig.result === 'no_improvements') {
      recordNoImprovement(state)
      state.iteration = iter
      await saveState(paths, state)
      log(
        `[${label}][${iter}] analyze: 개선 없음. streak = ${state.noImprovementStreak}/${config.threshold}`,
      )
      continue
    }

    const plannedCount = analyzeSig.plannedImprovements?.length ?? 1
    log(
      `[${label}][${iter}] analyze: 개선 발견 (${plannedCount}개 계획) → '${analyzeSig.nextImprovement}'. streak 리셋.`,
    )

    const planned: readonly PlannedImprovement[] =
      analyzeSig.plannedImprovements ?? [
        {
          id: '1',
          title: analyzeSig.nextImprovement ?? '(legacy improvement)',
        },
      ]
    const baselineDirty = opts.dryRun
      ? []
      : await statusPaths(paths.root, scope ? [scope] : [])
    const iterationSnapshot = opts.dryRun ? null : analyzeSnapshot
    const baselineHead = opts.dryRun
      ? '(dry-run)'
      : (iterationSnapshot?.head ?? null)
    if (!opts.dryRun && baselineDirty === null) {
      state.status = 'error'
      log(
        `[${label}][${iter}] improve 시작 전 Git 상태를 읽지 못해 안전한 귀속을 보장할 수 없습니다.`,
      )
      break
    }
    if (!opts.dryRun && baselineHead === null) {
      state.status = 'error'
      log(
        `[${label}][${iter}] improve 시작 전 Git HEAD를 읽지 못해 안전한 귀속을 보장할 수 없습니다.`,
      )
      break
    }
    if (
      !opts.dryRun &&
      config.commitPerIteration &&
      (baselineDirty?.length ?? 0) > 0
    ) {
      state.status = 'error'
      log(
        `[${label}][${iter}] 자동 커밋 모드는 IMPROVE 시작 전 깨끗한 대상 워킹트리가 필요합니다. 기존 변경을 먼저 커밋하거나 보관하세요.`,
      )
      break
    }
    const executeItemStage = createImproveStageExecutor({
      paths,
      scope,
      dryRun: opts.dryRun,
      initialBaseline: baselineDirty ?? [],
      ...(iterationSnapshot === null
        ? {}
        : { initialSnapshot: iterationSnapshot }),
      log,
      validate: (signal, run) => validateImproveSignal(signal, [run.item]),
      executePhase: (stagePaths, validate, retryGuard, run) =>
        runPhaseResilient(
          stagePaths,
          config,
          iter,
          'improve',
          opts,
          log,
          stateDirRel,
          scope,
          validate,
          retryGuard,
          {
            role: run.role,
            message: run.message,
            logPath: run.artifacts.log,
            item: run.item,
            stage: run.stage,
            reportPath: run.artifacts.report,
          },
        ),
    })
    const b = await runImproveBatch({
      paths,
      config,
      iteration: iter,
      planned,
      stateDirRel,
      scope,
      log,
      execute: executeItemStage,
    })
    if (b.kind !== 'ok') {
      if (b.kind === 'head-changed') {
        await quarantineHeadChange(paths, {
          expectedHead: b.expectedHead,
          actualHead: b.actualHead,
          iteration: iter,
          source: b.stage,
          itemId: b.itemId,
        })
        state.status = 'error'
        log(
          `[${label}][${iter}] item ${b.itemId} ${b.stage}가 Git HEAD를 변경했습니다. 커밋은 자동 reset하지 않고 격리했습니다.`,
        )
        break
      }
      if (iterationSnapshot !== null) {
        const restoreIssue = await rollbackIterationRepository(
          paths.root,
          iterationSnapshot,
        )
        if (restoreIssue !== null) {
          state.status = 'error'
          log(
            `[${label}][${iter}] 중단된 IMPROVE 윤회 복원 실패 — ${restoreIssue}`,
          )
          break
        }
        log(
          `[${label}][${iter}] 중단된 IMPROVE 윤회를 시작 상태로 복원했습니다.`,
        )
      }
      handlePhaseStop(state, b.kind, label, iter, 'improve', config, paths, log)
      break
    }
    const improveSig = b.signal
    const finalHead = opts.dryRun
      ? baselineHead
      : await headRevision(paths.root)
    if (!opts.dryRun && finalHead !== baselineHead) {
      if (typeof baselineHead === 'string' && finalHead !== null) {
        await quarantineHeadChange(paths, {
          expectedHead: baselineHead,
          actualHead: finalHead,
          iteration: iter,
          source: 'batch',
        })
      }
      state.status = 'error'
      log(
        `[${label}][${iter}] IMPROVE 중 Git HEAD가 변경되었습니다. 에이전트 커밋은 허용되지 않으며 드라이버 상세 커밋을 만들 수 없습니다.`,
      )
      break
    }
    await appendHistory(paths, config, iter, 'improve', improveSig)
    const kept = keptCountOf(improveSig)
    log(
      `[${label}][${iter}] improve: ${improveSig.result} — kept ${kept} (${improveSig.metricDelta ?? 'n/a'})`,
    )

    recordImproveOutcome(state, kept)
    if (kept === 0) {
      log(
        `[${label}][${iter}] 보존된 변경 없음(${improveSig.result}) → 윤회 전체 리버트. 리버트 streak = ${state.revertStreak}/${config.revertThreshold}`,
      )
    }
    // Commit only after the structured signal exists, so the message can explain every decision.
    if (!opts.dryRun) {
      await reconcileKeptCommit(
        paths,
        config,
        iter,
        improveSig,
        baselineDirty,
        scope,
        log,
      )
    }
    state.iteration = iter
    await saveState(paths, state)
  }

  await saveState(paths, state)
  // The invariant: a finished loop leaves a CLEAN tree. Surface (never auto-discard) any residue —
  // e.g. a crashed IMPROVE's leftovers or a rogue ANALYZE edit — so the user can review it.
  const residue = opts.dryRun
    ? []
    : await residualWorkingTree(paths.root, scope)
  if (residue.length > 0) {
    log(
      `[${label}] ⚠ 종료 시 워킹트리에 미정리 변경 ${residue.length}건 — 커밋도 리버트도 안 됨(검토 필요):`,
    )
    for (const line of residue.slice(0, 20)) log(`    ${line}`)
    if (residue.length > 20) log(`    … (+${residue.length - 20} 건 더)`)
  }
  await writeSummary(paths, state, config, target ?? undefined, residue)
  log(
    `[${label}] 종료: status=${state.status} iters=${state.iteration} streak=${state.noImprovementStreak}/${config.threshold}`,
  )
  log(`[${label}] summary: ${paths.summary}`)
  return {
    status: state.status,
    iterations: state.iteration,
    finalStreak: state.noImprovementStreak,
    threshold: state.threshold,
  }
}

/**
 * Run the loop(s) to a terminal state. Whole-repo when `config.targets` is empty, else one
 * independent loop per target. Resolves an aggregate result when everything stops.
 */
/**
 * Run the loop(s) under a project-local single-instance lock. A SECOND driver launched on the SAME
 * project is refused — that same-project double-run is the ONLY way `.retry-now/` state can contend.
 * Drivers on DIFFERENT projects each own their own `.retry-now/` and never conflict, so several
 * `bun` driver processes at once (one per project) is normal, NOT contention.
 */
export async function runLoop(
  config: RetryNowConfig,
  opts: DriverOptions,
): Promise<DriverResult> {
  const log = opts.log ?? ((line: string) => console.log(line))
  const paths = resolvePaths(opts.cwd)
  // Materialise .retry-now/ first (the lock file lives inside it), then take the project-local lock.
  await scaffold(opts.cwd, config, false)
  const lock = await acquireDriverLock(paths.driverLock, opts.cwd)
  if (!lock.ok) {
    log(
      `이미 이 프로젝트에서 윤회가 돌고 있습니다 (pid ${lock.holder.pid}, 시작 ${lock.holder.startedAt}). 중복 드라이버를 띄우지 않았습니다.`,
    )
    log(
      `참고: .retry-now/ 는 프로젝트 로컬 — 다른 프로젝트의 드라이버가 여럿 보여도 경합이 아닙니다(각자 자기 폴더). 멈추려면 .retry-now/STOP.`,
    )
    return {
      status: 'stopped-manual',
      iterations: 0,
      finalStreak: 0,
      threshold: config.threshold,
    }
  }
  try {
    return await runLoopBody(config, opts, log)
  } finally {
    await releaseDriverLock(paths.driverLock)
  }
}

async function runLoopBody(
  config: RetryNowConfig,
  opts: DriverOptions,
  log: (line: string) => void,
): Promise<DriverResult> {
  log(BANNER)
  log(
    `agents=analyze:${AGENT_LABEL[agentForRole(config, 'analyze')]}/implement:${AGENT_LABEL[agentForRole(config, 'improve')]}/review:${AGENT_LABEL[agentForRole(config, 'review')]}  ` +
      `models=analyze:${modelForRole(config, 'analyze') || 'agent default'}/implement:${modelForRole(config, 'improve') || 'agent default'}/review:${modelForRole(config, 'review') || 'agent default'}  ` +
      `stop-after=${config.threshold} no-improve / ${config.revertThreshold} reverts  ` +
      `max-iters=${config.maxIterations}  commit=${config.commitPerIteration ? 'on' : 'off'}  ` +
      `bench=${config.benchCommand ? `on×${config.benchRuns}` : 'off'}` +
      `${config.targets.length > 0 ? `  targets=${config.targets.length}` : ''}${opts.dryRun ? '  [DRY-RUN]' : ''}`,
  )

  if (config.targets.length === 0) {
    return runOneLoop(opts.cwd, null, config, opts, log)
  }

  log(
    `per-package 윤회(분할): ${config.targets.length}개 타겟 — 각자 독립 수렴`,
  )
  const results: { target: string; result: DriverResult }[] = []
  for (const target of config.targets) {
    log('═'.repeat(56))
    log(`◆ TARGET: ${target}`)
    const result = await runOneLoop(opts.cwd, target, config, opts, log)
    results.push({ target, result })
    if (await exists(resolvePaths(opts.cwd).stop)) {
      log('STOP 감지 — 남은 타겟을 중단합니다.')
      break
    }
  }

  await writeOverallSummary(opts.cwd, config, results)

  const anyError = results.some((r) => r.result.status === 'error')
  const anyPaused = results.some((r) => r.result.status === 'paused-quota')
  const anyManual = results.some((r) => r.result.status === 'stopped-manual')
  const allConverged =
    results.length > 0 &&
    results.every((r) => r.result.status === 'stopped-converged')
  const status: LoopState['status'] = anyError
    ? 'error'
    : anyPaused
      ? 'paused-quota'
      : allConverged
        ? 'stopped-converged'
        : anyManual
          ? 'stopped-manual'
          : 'stopped-maxiter'
  const iterations = results.reduce((sum, r) => sum + r.result.iterations, 0)

  log('')
  log(
    `=== 전체 윤회 종료 === targets=${results.length}  status=${status}  total-iters=${iterations}`,
  )
  log(`overall summary: ${resolvePaths(opts.cwd).summary}`)
  return { status, iterations, finalStreak: 0, threshold: config.threshold }
}

export interface RunProjectOptions {
  readonly dryRun?: boolean
  /** override config.commitPerIteration for this run only */
  readonly commitOverride?: boolean
  /** override config.waitForQuota for this run only (`--wait-for-quota` / `--no-wait-for-quota`) */
  readonly waitForQuotaOverride?: boolean
}

/**
 * Load a project's config and run its loop(s). Returns null when no `.retry-now/config.json`
 * exists. Shared by every agent frontend's driver entry (opencode / claude / codex) and the CLI.
 */
export async function runProjectLoop(
  cwd: string,
  opts: RunProjectOptions = {},
): Promise<DriverResult | null> {
  const loaded = await loadConfig(cwd)
  if (!loaded) return null
  const config =
    opts.commitOverride === undefined
      ? loaded
      : { ...loaded, commitPerIteration: opts.commitOverride }
  return runLoop(config, {
    cwd,
    dryRun: opts.dryRun ?? false,
    waitForQuota: opts.waitForQuotaOverride ?? config.waitForQuota,
  })
}

/**
 * Shared driver CLI: parse `--cwd <path> --dry-run --commit|--no-commit`, run the project loop,
 * and resolve a process exit code. Every agent frontend's driver entry is a thin shim over this.
 */
export async function runDriverCli(argv: readonly string[]): Promise<number> {
  const i = argv.indexOf('--cwd')
  const cwd = i >= 0 ? (argv[i + 1] ?? process.cwd()) : process.cwd()
  const dryRun = argv.includes('--dry-run')
  const commitOverride = argv.includes('--no-commit')
    ? false
    : argv.includes('--commit')
      ? true
      : undefined
  const waitForQuotaOverride = argv.includes('--no-wait-for-quota')
    ? false
    : argv.includes('--wait-for-quota')
      ? true
      : undefined
  const result = await runProjectLoop(cwd, {
    dryRun,
    ...(commitOverride === undefined ? {} : { commitOverride }),
    ...(waitForQuotaOverride === undefined ? {} : { waitForQuotaOverride }),
  })
  if (!result) {
    console.error(
      '이 프로젝트에 .retry-now/config.json 이 없다. 먼저 `retry-now init` 을 실행하라.',
    )
    return 1
  }
  return result.status === 'error' ? 1 : 0
}

export { resolvePaths }
