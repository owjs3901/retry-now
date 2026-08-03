import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DetectionResult } from '@retry-now/detect'
import { expect, test } from 'bun:test'

import { type InitDependencies, type InitPrompts, runInit } from '../init.ts'

const CANCEL = Symbol('cancel')
const ROLES = {
  analysisAgent: 'opencode',
  analysisModel: 'analysis/model',
  analysisVariant: 'max',
  improveAgent: 'codex',
  improveModel: 'improve/model',
  improveVariant: 'xhigh',
  reviewAgent: 'claude',
  reviewModel: 'review/model',
  reviewVariant: 'high',
} as const

const EMPTY_DETECTION: DetectionResult = {
  ecosystems: [],
  primary: null,
  test: '',
  lint: '',
  bench: '',
  isMonorepo: false,
  members: [],
  notes: [],
}

type PromptFixture = {
  readonly prompts: InitPrompts
  readonly notes: string[]
  readonly cancellations: string[]
  readonly validationErrors: string[]
}

function promptFixture(
  overrides: Readonly<
    Record<string, string | boolean | readonly string[]>
  > = {},
  cancelMessage = '',
): PromptFixture {
  const notes: string[] = []
  const cancellations: string[] = []
  const validationErrors: string[] = []
  const response = (
    message: string,
    fallback: string | boolean | readonly string[],
  ): string | boolean | readonly string[] | symbol => {
    if (message.includes(cancelMessage) && cancelMessage !== '') return CANCEL
    const entry = Object.entries(overrides).find(([key]) =>
      message.includes(key),
    )
    return entry?.[1] ?? fallback
  }
  return {
    prompts: {
      intro: (message) => notes.push(message),
      note: (message, title) => notes.push(`${title}:${message}`),
      text: async (options) => {
        const fallback = options.initialValue ?? options.defaultValue ?? ''
        const value = response(options.message, fallback)
        if (options.validate !== undefined) {
          const invalid = options.validate('0')
          if (invalid !== undefined) validationErrors.push(invalid)
          options.validate(typeof value === 'string' ? value : undefined)
        }
        return typeof value === 'string' || typeof value === 'symbol'
          ? value
          : fallback
      },
      confirm: async (options) => {
        const value = response(options.message, options.initialValue)
        return typeof value === 'boolean' || typeof value === 'symbol'
          ? value
          : options.initialValue
      },
      select: async (options) => {
        const value = response(options.message, options.initialValue)
        return typeof value === 'string' || typeof value === 'symbol'
          ? value
          : options.initialValue
      },
      multiselect: async (options) => {
        const value = response(options.message, options.initialValues)
        return Array.isArray(value) || typeof value === 'symbol'
          ? value
          : options.initialValues
      },
      isCancel: (value): value is symbol => typeof value === 'symbol',
      cancel: (message) => cancellations.push(message),
      outro: (message) => notes.push(message),
    },
    notes,
    cancellations,
    validationErrors,
  }
}

function dependencies(
  fixture: PromptFixture,
  detection: DetectionResult = EMPTY_DETECTION,
  roles: typeof ROLES | null = ROLES,
): InitDependencies {
  return {
    prompts: fixture.prompts,
    detectCapabilities: async () => detection,
    askRoleAgentSettings: async () => roles,
  }
}

test('writes a whole-repository config from custom verification answers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-init-'))
  const fixture = promptFixture({
    '자동 검증 없이': false,
    'test 명령': 'bun test',
    'lint 명령': 'bun run lint',
    '벤치마크 명령': '',
  })
  try {
    const code = await runInit(root, dependencies(fixture))
    const config = JSON.parse(
      await readFile(join(root, '.retry-now', 'config.json'), 'utf8'),
    ) as Record<string, unknown>

    expect(code).toBe(0)
    expect(config.verifyEnabled).toBe(true)
    expect(config.verifyTest).toBe('bun test')
    expect(config.verifyLint).toBe('bun run lint')
    expect(config.benchCommand).toBe('')
    expect(config.targets).toEqual([])
    expect(fixture.validationErrors).toHaveLength(2)
    expect(fixture.notes.join('\n')).toContain('윤회 모드: 전체 레포 단일 윤회')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('writes selected monorepo targets and replacement benchmark settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-init-'))
  const fixture = promptFixture({
    '감지된 명령': true,
    '감지된 벤치마크': false,
    '대신 쓸 벤치마크': 'bun bench:custom',
    '몇 번 반복': '7',
    '어떻게 윤회': 'each',
    '패키지 선택': ['packages/a'],
  })
  const detection: DetectionResult = {
    ecosystems: ['node'],
    primary: 'node',
    test: 'bun test',
    lint: 'bun run lint',
    bench: 'bun bench',
    isMonorepo: true,
    members: [
      { name: 'a', path: 'packages/a' },
      { name: 'b', path: 'packages/b' },
    ],
    notes: [],
  }
  try {
    expect(await runInit(root, dependencies(fixture, detection))).toBe(0)
    const config = JSON.parse(
      await readFile(join(root, '.retry-now', 'config.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(config.benchCommand).toBe('bun bench:custom')
    expect(config.benchRuns).toBe(7)
    expect(config.targets).toEqual(['packages/a'])
    expect(fixture.validationErrors).toHaveLength(3)
    expect(fixture.notes.join('\n')).toContain('패키지별 분할')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const CANCELLATIONS: readonly {
  readonly message: string
  readonly detection?: DetectionResult
  readonly overrides?: Readonly<
    Record<string, string | boolean | readonly string[]>
  >
}[] = [
  { message: '1. 분석' },
  { message: '2. 개선' },
  { message: '3. 완료' },
  { message: '수렴 임계값 —' },
  { message: '리버트 수렴' },
  { message: '권한 확인' },
  { message: 'git commit' },
  {
    message: '감지된 명령',
    detection: { ...EMPTY_DETECTION, test: 'bun test' },
  },
  { message: '자동 검증 없이' },
  {
    message: 'test 명령',
    overrides: { '자동 검증 없이': false },
  },
  {
    message: 'lint 명령',
    overrides: { '자동 검증 없이': false },
  },
  { message: '벤치마크 명령' },
  {
    message: '감지된 벤치마크',
    detection: { ...EMPTY_DETECTION, bench: 'bun bench' },
  },
  {
    message: '대신 쓸 벤치마크',
    detection: { ...EMPTY_DETECTION, bench: 'bun bench' },
    overrides: { '감지된 벤치마크': false },
  },
  {
    message: '몇 번 반복',
    detection: { ...EMPTY_DETECTION, bench: 'bun bench' },
  },
  {
    message: '어떻게 윤회',
    detection: {
      ...EMPTY_DETECTION,
      isMonorepo: true,
      members: [{ name: 'a', path: 'packages/a' }],
    },
  },
  {
    message: '패키지 선택',
    detection: {
      ...EMPTY_DETECTION,
      isMonorepo: true,
      members: [{ name: 'a', path: 'packages/a' }],
    },
    overrides: { '어떻게 윤회': 'each' },
  },
]

for (const cancellation of CANCELLATIONS) {
  test(`returns 130 when '${cancellation.message}' is cancelled`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'retry-now-init-cancel-'))
    const fixture = promptFixture(cancellation.overrides, cancellation.message)
    try {
      expect(
        await runInit(
          root,
          dependencies(fixture, cancellation.detection ?? EMPTY_DETECTION),
        ),
      ).toBe(130)
      expect(fixture.cancellations).toEqual([
        '취소되었다. 다음 생에서 다시 만나자.',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('returns 130 when role-agent selection is cancelled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-init-cancel-'))
  const fixture = promptFixture()
  try {
    expect(
      await runInit(root, dependencies(fixture, EMPTY_DETECTION, null)),
    ).toBe(130)
    expect(fixture.cancellations).toHaveLength(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reports invalid normalized configuration without writing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-init-error-'))
  const fixture = promptFixture({ '1. 분석': '' })
  try {
    expect(await runInit(root, dependencies(fixture))).toBe(1)
    expect(fixture.cancellations[0]).toContain('설정 오류:')
    expect(
      await Bun.file(join(root, '.retry-now', 'config.json')).exists(),
    ).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
