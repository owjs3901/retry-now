/**
 * `retry-now init` — the interactive setup UI.
 *
 * opencode's TUI cannot render a multi-field form from a plugin (server plugins have no UI
 * primitives), so the "UI를 통하여" collection lives here, in a purpose-built CLI form. It
 * gathers the three user prompts (분석/개선방향/완료체크) plus the convergence threshold,
 * then writes `.retry-now/config.json` and scaffolds the runtime directory.
 */
import * as p from '@clack/prompts'
import {
  DEFAULT_BENCH_RUNS,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_REVERT_THRESHOLD,
  DEFAULT_THRESHOLD,
  normalizeConfig,
  oathBlock,
  type RetryNowConfig,
  scaffold,
  variantForRole,
  VERSION,
} from '@retry-now/core'
import { detectCapabilities, type DetectionResult } from '@retry-now/detect'

import {
  askRoleAgentSettings,
  type RoleAgentSettings,
} from './agent-settings.ts'

// Agent-bound defaults are English on purpose: they get injected into the analyze/improve
// prompts sent every iteration, where English is more token-efficient than Korean.
const DEFAULT_ANALYSIS =
  'Analyse all source code for runtime performance regressions, latent bugs, and code-quality issues; report concrete, actionable improvement opportunities grounded in file:line citations.'
const DEFAULT_DIRECTION =
  'Priority order: speed/throughput > memory > code quality. Never break tests. Smallest correct change only. No cheats (e.g. fixture patches that fake the result).'
const DEFAULT_COMPLETION =
  'Done when static analysis/lint is clean, all benchmarks sit within noise, and there is no remaining change genuinely worth making.'

type TextOptions = {
  readonly message: string
  readonly placeholder: string
  readonly initialValue?: string
  readonly defaultValue?: string
  readonly validate?: (value: string | undefined) => string | undefined
}

export type InitPrompts = {
  readonly intro: (message: string) => void
  readonly note: (message: string, title: string) => void
  readonly text: (options: TextOptions) => Promise<string | symbol>
  readonly confirm: (options: {
    readonly message: string
    readonly initialValue: boolean
  }) => Promise<boolean | symbol>
  readonly select: (options: {
    readonly message: string
    readonly options: {
      readonly value: string
      readonly label: string
      readonly hint: string
    }[]
    readonly initialValue: string
  }) => Promise<string | symbol>
  readonly multiselect: (options: {
    readonly message: string
    readonly options: {
      readonly value: string
      readonly label: string
      readonly hint: string
    }[]
    readonly initialValues: string[]
    readonly required: boolean
  }) => Promise<string[] | symbol>
  readonly isCancel: (value: unknown) => value is symbol
  readonly cancel: (message: string) => void
  readonly outro: (message: string) => void
}

export type InitDependencies = {
  readonly prompts: InitPrompts
  readonly detectCapabilities: (cwd: string) => Promise<DetectionResult>
  readonly askRoleAgentSettings: () => Promise<RoleAgentSettings | null>
}

const CLACK_PROMPTS: InitPrompts = {
  intro: p.intro,
  note: p.note,
  text: p.text,
  confirm: p.confirm,
  select: p.select,
  multiselect: p.multiselect,
  isCancel: p.isCancel,
  cancel: p.cancel,
  outro: p.outro,
}

const INIT_DEPENDENCIES: InitDependencies = {
  prompts: CLACK_PROMPTS,
  detectCapabilities,
  askRoleAgentSettings,
}

function cancelled(value: unknown, prompts: InitPrompts): value is symbol {
  return prompts.isCancel(value)
}

export async function runInit(
  cwd: string,
  dependencies: InitDependencies = INIT_DEPENDENCIES,
): Promise<number> {
  const { prompts } = dependencies
  prompts.intro(`retry-now v${VERSION} · 지금 바로 윤회`)
  prompts.note(oathBlock(), '맹세')

  const detected = await dependencies.detectCapabilities(cwd)
  prompts.note(
    [
      `ecosystem: ${detected.ecosystems.length ? detected.ecosystems.join(', ') : '감지 안 됨'}`,
      `test : ${detected.test || '(없음)'}`,
      `lint : ${detected.lint || '(없음)'}`,
      `bench: ${detected.bench || '(없음)'}`,
    ].join('\n'),
    '감지된 환경 (@retry-now/detect)',
  )

  const roleAgents = await dependencies.askRoleAgentSettings()
  if (!roleAgents) return cancel(prompts)

  const analysis = await prompts.text({
    message: '1. 분석 및 계획 — 무엇을 분석/계획할지',
    placeholder: DEFAULT_ANALYSIS,
    initialValue: DEFAULT_ANALYSIS,
  })
  if (cancelled(analysis, prompts)) return cancel(prompts)

  const direction = await prompts.text({
    message: '2. 개선 방향 — 어떻게 개선할지 (우선순위·제약)',
    placeholder: DEFAULT_DIRECTION,
    initialValue: DEFAULT_DIRECTION,
  })
  if (cancelled(direction, prompts)) return cancel(prompts)

  const completion = await prompts.text({
    message: "3. 완료 체크 — 언제 '더 개선할 게 없다'고 볼지",
    placeholder: DEFAULT_COMPLETION,
    initialValue: DEFAULT_COMPLETION,
  })
  if (cancelled(completion, prompts)) return cancel(prompts)

  const thresholdRaw = await prompts.text({
    message: "수렴 임계값 — 몇 생 연속 '개선 없음'이면 맺어졌다(완벽)고 볼지",
    placeholder: String(DEFAULT_THRESHOLD),
    initialValue: String(DEFAULT_THRESHOLD),
    validate: (v) => {
      const n = Number(v)
      if (!Number.isInteger(n) || n < 1) return '1 이상의 정수를 입력하세요.'
      return undefined
    },
  })
  if (cancelled(thresholdRaw, prompts)) return cancel(prompts)

  const revertThresholdRaw = await prompts.text({
    message:
      "리버트 수렴 임계값 — 몇 생 연속 '윤회 전체 리버트(회귀로 되돌림)'면 더 손댈 게 없다고 볼지",
    placeholder: String(DEFAULT_REVERT_THRESHOLD),
    initialValue: String(DEFAULT_REVERT_THRESHOLD),
    validate: (v) => {
      const n = Number(v)
      if (!Number.isInteger(n) || n < 1) return '1 이상의 정수를 입력하세요.'
      return undefined
    },
  })
  if (cancelled(revertThresholdRaw, prompts)) return cancel(prompts)

  const skipPermissions = await prompts.confirm({
    message:
      '무인 실행을 위해 권한 확인을 건너뛸까? (--dangerously-skip-permissions 류)',
    initialValue: true,
  })
  if (cancelled(skipPermissions, prompts)) return cancel(prompts)

  const commitPerIteration = await prompts.confirm({
    message:
      '각 윤회의 보존 변경을 상세 git commit으로 남길까? (적용/계획 수, 효과, 검증·제외 사유 포함)',
    initialValue: true,
  })
  if (cancelled(commitPerIteration, prompts)) return cancel(prompts)

  // Step-3 verification (완료 체크): use detected test/lint to confirm each 윤회 ran cleanly,
  // or — if none detected — ask whether proceeding without it is OK (offer a custom command).
  let verifyEnabled = false
  let verifyTest = ''
  let verifyLint = ''
  if (detected.test !== '' || detected.lint !== '') {
    const useVerify = await prompts.confirm({
      message: `step3(완료 체크)에서 감지된 명령으로 매 윤회를 검증할까? (test: ${detected.test || '-'}, lint: ${detected.lint || '-'})`,
      initialValue: true,
    })
    if (cancelled(useVerify, prompts)) return cancel(prompts)
    verifyEnabled = useVerify
    if (useVerify) {
      verifyTest = detected.test
      verifyLint = detected.lint
    }
  } else {
    const okNone = await prompts.confirm({
      message: 'test/lint가 감지되지 않았다. 자동 검증 없이 진행해도 괜찮아?',
      initialValue: true,
    })
    if (cancelled(okNone, prompts)) return cancel(prompts)
    if (!okNone) {
      const customTest = await prompts.text({
        message: '검증에 쓸 test 명령 (없으면 비워둠)',
        placeholder: 'e.g. npm test',
        defaultValue: '',
      })
      if (cancelled(customTest, prompts)) return cancel(prompts)
      const customLint = await prompts.text({
        message: '검증에 쓸 lint 명령 (없으면 비워둠)',
        placeholder: 'e.g. npm run lint',
        defaultValue: '',
      })
      if (cancelled(customLint, prompts)) return cancel(prompts)
      verifyTest = customTest
      verifyLint = customLint
      verifyEnabled = customTest !== '' || customLint !== ''
    }
  }

  // Benchmark: STRONGLY recommended so every 윤회 can prove it did not regress speed (before/after,
  // median of N runs). Use the detected command, or ask for one when none was found.
  let benchCommand = detected.bench
  if (benchCommand === '') {
    const customBench = await prompts.text({
      message:
        '벤치마크 명령 (강력 권장 — 윤회마다 before/after로 회귀 방지). 없으면 비워둠',
      placeholder: 'e.g. cargo bench / npm run bench / ./bench.sh',
      defaultValue: '',
    })
    if (cancelled(customBench, prompts)) return cancel(prompts)
    benchCommand = customBench
  } else {
    const keepBench = await prompts.confirm({
      message: `감지된 벤치마크 명령을 쓸까? (${benchCommand})`,
      initialValue: true,
    })
    if (cancelled(keepBench, prompts)) return cancel(prompts)
    if (!keepBench) {
      const customBench = await prompts.text({
        message: '대신 쓸 벤치마크 명령 (없으면 비워둠)',
        placeholder: 'e.g. cargo bench',
        defaultValue: '',
      })
      if (cancelled(customBench, prompts)) return cancel(prompts)
      benchCommand = customBench
    }
  }

  let benchRuns = DEFAULT_BENCH_RUNS
  if (benchCommand !== '') {
    const benchRunsRaw = await prompts.text({
      message:
        '벤치 공정성 — 시스템 편차를 줄이려 before/after 각각 몇 번 반복 측정할지 (중앙값 비교)',
      placeholder: String(DEFAULT_BENCH_RUNS),
      initialValue: String(DEFAULT_BENCH_RUNS),
      validate: (v) => {
        const n = Number(v)
        if (!Number.isInteger(n) || n < 1) return '1 이상의 정수를 입력하세요.'
        return undefined
      },
    })
    if (cancelled(benchRunsRaw, prompts)) return cancel(prompts)
    benchRuns = Number(benchRunsRaw)
  }

  // Monorepo: choose whole-repo vs per-package (분할) 윤회. If per-package, multi-select members
  // (all checked by default → keep only the ones you want).
  let targets: string[] = []
  if (detected.isMonorepo && detected.members.length > 0) {
    const mode = await prompts.select({
      message: `모노레포 감지됨 (${detected.members.length}개 패키지). 어떻게 윤회할까?`,
      options: [
        {
          value: 'whole',
          label: '전체를 하나로 윤회',
          hint: '레포 전체를 단일 윤회로',
        },
        {
          value: 'each',
          label: '패키지별 분할 윤회',
          hint: '선택한 각 패키지를 독립적으로 수렴',
        },
      ],
      initialValue: 'whole',
    })
    if (cancelled(mode, prompts)) return cancel(prompts)
    if (mode === 'each') {
      const picked = await prompts.multiselect({
        message: '윤회할 패키지 선택 (전부 체크됨 — 원하는 것만 남기세요)',
        options: detected.members.map((m) => ({
          value: m.path,
          label: m.name,
          hint: m.path,
        })),
        initialValues: detected.members.map((m) => m.path),
        required: false,
      })
      if (cancelled(picked, prompts)) return cancel(prompts)
      targets = picked
    }
  }

  let config: RetryNowConfig
  try {
    config = normalizeConfig({
      agent: roleAgents.analysisAgent,
      ...roleAgents,
      analysis,
      direction,
      completion,
      threshold: Number(thresholdRaw),
      revertThreshold: Number(revertThresholdRaw),
      maxIterations: DEFAULT_MAX_ITERATIONS,
      skipPermissions,
      commitPerIteration,
      verifyEnabled,
      verifyTest,
      verifyLint,
      benchCommand,
      benchRuns,
      targets,
    })
  } catch (err) {
    prompts.cancel(
      `설정 오류: ${err instanceof Error ? err.message : String(err)}`,
    )
    return 1
  }

  await scaffold(cwd, config, true)

  prompts.note(
    [
      `.retry-now/ 생성됨 (전체 git 제외: .gitignore = '*').`,
      config.targets.length > 0
        ? `윤회 모드: 패키지별 분할 (${config.targets.length}개 타겟, 각자 독립 수렴)`
        : `윤회 모드: 전체 레포 단일 윤회`,
      `agents: 분석=${config.analysisAgent} / 구현=${config.improveAgent} / 검토=${config.reviewAgent}`,
      `모델: 분석=${config.analysisModel || 'agent default'} / 구현=${config.improveModel || 'agent default'} / 검토=${config.reviewModel || 'agent default'}`,
      `variant: 분석=${variantForRole(config, 'analyze')} / 구현=${variantForRole(config, 'improve')} / 검토=${variantForRole(config, 'review')} (미설정 시 최고 등급 자동)`,
      `수렴: ${config.threshold}생 연속 개선없음 또는 ${config.revertThreshold}생 연속 전체 리버트`,
      config.benchCommand
        ? `벤치마크: ${config.benchCommand} (before/after ${config.benchRuns}회 중앙값, 회귀 시 리버트)`
        : `벤치마크: 미설정 (권장 — 회귀 자동 감지 불가)`,
      `긴 프롬프트는 .retry-now/config.json 에서 편집 후 다시 실행하면 반영된다.`,
      ``,
      `시작:`,
      `  • CLI:      retry-now run`,
      `  • opencode: /retry-now`,
    ].join('\n'),
    '준비 완료',
  )
  prompts.outro('운명이여, 무릎 꿇어라.')
  return 0
}

function cancel(prompts: InitPrompts): number {
  prompts.cancel('취소되었다. 다음 생에서 다시 만나자.')
  return 130
}
