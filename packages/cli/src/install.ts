/**
 * `retry-now install <opencode|claude|codex> [--cwd <root>] [--personal]`
 *
 * Writes the per-agent trigger file (opencode command / claude command / codex skill) with the
 * absolute driver command baked in, so invoking it launches the loop with no global install.
 */
import { resolve } from 'node:path'

import { AGENT_KINDS, type AgentKind, installFrontend } from '@retry-now/core'

export async function runInstall(
  cliEntry: string,
  agentRaw: string,
  cwd: string,
  personal: boolean,
): Promise<number> {
  const agent = agentRaw as AgentKind
  if (!agentRaw || !AGENT_KINDS.includes(agent)) {
    console.error(
      `설치 대상은 ${AGENT_KINDS.join(' | ')} 중 하나여야 한다 (받음: "${agentRaw}").`,
    )
    console.error('예) retry-now install claude')
    return 1
  }

  // Bake `bun "<cliEntry>" run` as the driver. installFrontend appends --cwd for project
  // installs and resolves the per-agent destination path + invocation syntax.
  const r = await installFrontend(agent, `bun "${cliEntry}" run`, {
    cwd: resolve(cwd),
    personal,
  })
  console.log(`설치 완료 — ${agent} (${r.personal ? 'personal' : 'project'})`)
  console.log(`  파일 : ${r.dest}`)
  console.log(`  호출 : ${r.invoke}`)
  console.log('  (설정이 없으면 먼저 `retry-now init`)')
  return 0
}
