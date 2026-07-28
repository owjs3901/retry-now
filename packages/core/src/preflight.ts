/**
 * Baseline preflight for the configured verification commands.
 *
 * The loop reverts any item whose verification goes red. If a command is ALREADY red at HEAD —
 * a pre-existing lint warning in a test helper is enough — then every item this loop ever proposes
 * gets reverted for a failure it did not cause. Nothing is kept, `revertStreak` climbs to
 * `revertThreshold`, and the run reports the most misleading outcome this tool can produce:
 * "맺어졌다 (converged)". A silently wrong success is worse than a loud failure, so the baseline is
 * measured ONCE before the first life and the answer is stated plainly.
 *
 * Only test/lint gate. A red benchmark degrades measurement quality but does not poison a verdict,
 * so it warns without blocking.
 */
import type { CommandRunner, RetryNowConfig } from './types.ts'

export type { CommandRunner }

export type PreflightRole = 'test' | 'lint' | 'benchmark'

export type PreflightCommand = {
  readonly role: PreflightRole
  readonly command: string
  /**
   * True when a red result makes every item's kept/reverted verdict untrustworthy. Test and lint
   * gate because the loop's revert decision reads them directly; the benchmark does not.
   */
  readonly gating: boolean
}

export type PreflightResult = PreflightCommand & {
  /** process exit code; `TIMED_OUT` when the command outlived its budget */
  readonly code: number
}

/** Exit code reported for a command that had to be killed. Distinct from any real shell status. */
export const TIMED_OUT = -2

/** The slice of a spawned child this module needs, kept tiny so tests can supply a fake one. */
export type SpawnedCommand = {
  on(event: 'error', listener: (error: Error) => void): void
  on(event: 'close', listener: (code: number | null) => void): void
  kill(): void
}

export type SpawnCommand = (command: string, cwd: string) => SpawnedCommand

/**
 * The spawn itself is supplied by the driver rather than defaulted here, for two reasons. The
 * commands are the PROJECT'S OWN test and lint commands, so a test that exercised a real spawn
 * would re-enter the suite running it; and creating real child processes under the coverage
 * instrumenter is what this module must not force on the test suite. `loop-driver.ts` owns process
 * creation already — that is why it is the file excluded from coverage — so the shell lives there
 * and everything decision-shaped lives here, fully testable against a fake child.
 */
export function createCommandRunner(spawnCommand: SpawnCommand): CommandRunner {
  return (command, cwd, timeoutMs) =>
    new Promise((resolve) => {
      const child = spawnCommand(command, cwd)
      let settled = false
      const finish = (code: number): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(code)
      }
      const timer = setTimeout(() => {
        child.kill()
        finish(TIMED_OUT)
      }, timeoutMs)
      child.on('error', () => finish(-1))
      child.on('close', (code) => finish(code ?? -1))
    })
}

/** The commands worth measuring, in the order a user reads them. */
export function preflightCommands(
  config: RetryNowConfig,
): readonly PreflightCommand[] {
  const verify = config.verifyEnabled
  return [
    ...(verify && config.verifyTest !== ''
      ? [{ role: 'test' as const, command: config.verifyTest, gating: true }]
      : []),
    ...(verify && config.verifyLint !== ''
      ? [{ role: 'lint' as const, command: config.verifyLint, gating: true }]
      : []),
    ...(config.benchCommand !== ''
      ? [
          {
            role: 'benchmark' as const,
            command: config.benchCommand,
            gating: false,
          },
        ]
      : []),
  ]
}

/** Measure every configured command once at the current HEAD. */
export async function runBaselinePreflight(
  root: string,
  config: RetryNowConfig,
  run: CommandRunner,
): Promise<readonly PreflightResult[]> {
  const results: PreflightResult[] = []
  for (const command of preflightCommands(config)) {
    results.push({
      ...command,
      code: await run(command.command, root, config.phaseTimeoutMs),
    })
  }
  return results
}

function describeResult(result: PreflightResult): string {
  return `${result.role}: \`${result.command}\` → ${
    result.code === TIMED_OUT ? '시간 초과' : `exit ${result.code}`
  }`
}

/** Re-run only the commands that decide whether a reviewed item may become approved. */
export async function verifyGatingCommands(
  root: string,
  config: RetryNowConfig,
  run: CommandRunner,
): Promise<string | null> {
  const results: PreflightResult[] = []
  for (const command of preflightCommands(config)) {
    if (!command.gating) continue
    results.push({
      ...command,
      code: await run(command.command, root, config.phaseTimeoutMs),
    })
  }
  const red = results.find((result) => result.code !== 0)
  return red === undefined ? null : describeResult(red)
}

/** A red gating command means every item's verdict this run would be untrustworthy. */
export function hasGatingFailure(results: readonly PreflightResult[]): boolean {
  return results.some((result) => result.gating && result.code !== 0)
}

/**
 * The user-facing verdict. Returns null when the baseline is trustworthy (including the case where
 * nothing is configured — that is the user's explicit choice, already surfaced at `init`).
 */
export function preflightReport(
  results: readonly PreflightResult[],
): readonly string[] | null {
  const red = results.filter((result) => result.code !== 0)
  if (red.length === 0) return null

  if (!hasGatingFailure(results)) {
    return [
      '⚠ 베이스라인 벤치마크 명령이 HEAD에서 실패합니다:',
      ...red.map((result) => `  - ${describeResult(result)}`),
      '  성능 변화를 측정할 수 없으므로 벤치마크 기반 판단은 신뢰할 수 없습니다. 윤회는 계속합니다.',
    ]
  }

  return [
    '⚠ 시작 거부 — 검증 명령이 이미 HEAD에서 실패합니다(내 변경 때문이 아닙니다):',
    ...red.map((result) => `  - ${describeResult(result)}`),
    '',
    '  이대로 두면 모든 개선이 "검증 실패"로 리버트되고, 아무것도 보존되지 않은 채',
    `  revertThreshold에 도달해 "맺어졌다(수렴)"라는 거짓 완료가 납니다.`,
    '',
    '  다음 중 하나를 하세요:',
    '  1. 위 명령이 HEAD에서 통과하도록 먼저 고칩니다(권장).',
    '  2. .retry-now/config.json 에서 해당 명령을 비웁니다.',
    '  3. .retry-now/config.json 의 verifyEnabled 를 false 로 두고 검증 없이 돕니다.',
  ]
}
