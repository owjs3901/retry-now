/**
 * Scaffolding: materialise the `.retry-now/` runtime directory inside a target project.
 *
 * Idempotent. `config.json` is written once (init owns it) but the derived prompt files,
 * README, ledger header and `.gitignore` are always (re)generated so editing the config and
 * re-running keeps the prompts in sync.
 */
import { ensureDir, exists, writeJson, writeText } from './io.ts'
import type { Paths } from './paths.ts'
import { DIR, resolvePaths } from './paths.ts'
import { buildAnalyzePrompt, buildImprovePrompt } from './prompts.ts'
import { oathBlock } from './theme.ts'
import type { RetryNowConfig } from './types.ts'

/**
 * Write the analyze + improve prompts for a given paths/stateDir/scope. Shared by `scaffold`
 * (root, whole-repo) and the driver (per-target, scoped). `stateDirRel` is the on-disk dir the
 * agent reads/writes from (e.g. `.retry-now` or `.retry-now/targets/<slug>`); `scope` is the
 * package path for a per-package 윤회 (or "" for whole-repo).
 */
export async function writePrompts(
  paths: Paths,
  config: RetryNowConfig,
  stateDirRel: string,
  scope: string,
): Promise<void> {
  await ensureDir(paths.promptsDir)
  await writeText(
    paths.analyzePrompt,
    buildAnalyzePrompt(config, stateDirRel, scope),
  )
  await writeText(
    paths.improvePrompt,
    buildImprovePrompt(config, stateDirRel, scope),
  )
}

export const LEDGER_HEADER = `# Improvement Ledger (human-facing history)

> Human-facing summary of every change the IMPROVE phase attempted.
> **Intentionally NOT read by the ANALYZE phase** — analyze must judge the *current* state
> freshly, without bias from prior lives. Applied improvements live in the code itself, so a
> fresh analysis naturally won't re-propose them.

| Iter | Improvement | Outcome | Metric delta | Files |
|------|-------------|---------|--------------|-------|
`

function runtimeReadme(config: RetryNowConfig): string {
  const verifyDesc =
    config.verifyEnabled &&
    (config.verifyTest !== '' || config.verifyLint !== '')
      ? `매 윤회 개선 후 검증 실행, 실패 시 되돌림 (test: ${config.verifyTest || '-'}, lint: ${config.verifyLint || '-'})`
      : '자동 test/lint 미설정 — 에이전트 자체 판단으로 검증'
  const benchDesc = config.benchCommand
    ? `${config.benchCommand} (before/after ${config.benchRuns}회 중앙값, 회귀 시 리버트)`
    : '미설정 (권장)'
  return `# .retry-now — 지금 바로 윤회 (runtime state)

자율 개선 윤회 상태 디렉토리. **모든 내용은 \`.gitignore\`(= \`*\`)로 git에서 제외**된다.

${oathBlock()}

핵심 원칙: 매 이터레이션은 새 \`${config.agent}\` 세션으로 **컨텍스트가 0으로 환생**한다.
이터레이션을 가로지르는 유일한 상태는 \`state.json\`의 **연속 no-improvement 스트릭**뿐이며,
이는 드라이버가 소유한다. ANALYZE는 이전 리포트/렉저/히스토리/state를 **읽지 않는다**(편향 금지).

매 ANALYZE는 한 번의 무편향 분석으로 **최대 \`${config.improvementBatchSize}\`개**를 배치로 계획하고,
IMPROVE가 항목별 백업→적용→체크포인트 검증으로 **각각 보존/되돌림**한다(부분 성공 허용). 한 번의 분석을
배치 전체에 분산하므로 분석 토큰이 윤회마다 버려지지 않는다. (\`improvementBatchSize = 1\`이면 항목 1개 = 옛 동작.)

윤회는 ANALYZE가 \`${config.threshold}\`생 연속 \`no_improvements\`를 내거나, IMPROVE가
\`${config.revertThreshold}\`생 연속 **한 항목도 보존하지 못하면(배치 kept 0)** **맺어졌다(수렴)**고
판단하고 멈춘다. 안전 상한 \`maxIterations = ${config.maxIterations}\`.

git 커밋: ${config.commitPerIteration ? '**켜짐** — 각 윤회의 KEEP 항목들을 묶어 `retry-now#NNNN:` 프리픽스로 **1커밋**. 항목별 귀속은 report/ledger에 보존되며, 윤회별로 git에서 변경을 리뷰할 수 있다.' : '**꺼짐** — 변경분은 워킹트리에만 남기고 커밋하지 않는다.'}

step1(분석)은 **반드시 비파괴(read-only)** 다. step3(완료 체크): ${verifyDesc}.
벤치마크: ${benchDesc}. 모든 윤회 종료 시 **종합 보고서 \`summary.md\`** 가 생성된다.

## 파일
| 경로 | 역할 |
|---|---|
| \`config.json\` | 사용자 의도(분석/개선방향/완료체크/임계값) — 정적, 편향원 아님 |
| \`prompts/analyze.md\` | config로 합성된 분석 프롬프트(무편향 규칙 명시) |
| \`prompts/improve.md\` | config로 합성된 개선 프롬프트(백업·되돌리기 게이트) |
| \`state.json\` | 드라이버 상태(iteration, streak, status) — **분석에 되먹임 X** |
| \`current.json\` | 이번 생 id/phase (에이전트에 주는 유일 단서) |
| \`signal.json\` | 에이전트→드라이버 단방향 신호(매 phase 덮어씀) |
| \`history.jsonl\` | append-only 머신 로그 |
| \`ledger.md\` | 적용 내역 요약(사람용) |
| \`reports/NNNN-*.md\` | 매 분석/개선 결과 |
| \`backups/NNNN/\` | IMPROVE 파일 백업(회귀 시 복원원) |
| \`logs/iter-NNNN-*.log\` | 에이전트 stdout 원본 |
| \`STOP\` | 이 파일을 만들면 다음 경계에서 수동 정지 |

## 정지 / 재개 / 리셋
- 수동 정지: \`.retry-now/STOP\` 생성 (상태 보존).
- 재개: 드라이버 재실행. \`state.json\`의 iteration/streak부터 이어감(STOP 먼저 삭제).
- 리셋: \`state.json\` 삭제 또는 iteration/streak=0, status="running".
`
}

/**
 * Create or refresh the runtime directory. Returns resolved paths.
 *
 * @param writeConfig when true, (over)writes config.json. init passes true; the driver
 *        passes false so it never clobbers user config, only refreshes derived files.
 */
export async function scaffold(
  root: string,
  config: RetryNowConfig,
  writeConfig = false,
): Promise<Paths> {
  const paths = resolvePaths(root)

  for (const d of [
    paths.dir,
    paths.promptsDir,
    paths.reportsDir,
    paths.logsDir,
  ]) {
    await ensureDir(d)
  }

  // The whole runtime dir is local-only: a single `*` ignores everything inside the folder
  // (this `.gitignore` itself included), so git never tracks `.retry-now/`. The project's root
  // `.gitignore` is intentionally left untouched — the inner ignore already fully covers it.
  await writeText(paths.gitignore, '*\n')

  if (writeConfig || !(await exists(paths.config))) {
    await writeJson(paths.config, config)
  }

  // Always regenerate derived artifacts from the (possibly updated) config.
  await writePrompts(paths, config, DIR, '')
  await writeText(paths.readme, runtimeReadme(config))

  if (!(await exists(paths.ledger))) {
    await writeText(paths.ledger, LEDGER_HEADER)
  }

  return paths
}
