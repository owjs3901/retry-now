#!/usr/bin/env bun
/**
 * `@retry-now/codex` — Codex CLI integration.
 *
 * `bunx @retry-now/codex [--cwd <path>] [--personal]` installs a `$retry-now` skill into
 * `.agents/skills/retry-now/SKILL.md` (project) or `~/.agents/skills/retry-now/SKILL.md`
 * (personal) with this package's driver baked in. (Codex removed `~/.codex/prompts/` in
 * 0.117.0; skills under `.agents/skills/` replace it.) Also exported as `install()`.
 */
import { fileURLToPath } from 'node:url'

import { type FrontendInstallResult, installFrontend } from '@retry-now/core'

const DRIVER = fileURLToPath(new URL('./driver-entry.ts', import.meta.url))

export function install(
  opts: { cwd?: string; personal?: boolean } = {},
): Promise<FrontendInstallResult> {
  return installFrontend('codex', `bun "${DRIVER}"`, opts)
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const personal = argv.includes('--personal')
  const ci = argv.indexOf('--cwd')
  const cwd = ci >= 0 ? argv[ci + 1] : undefined
  install({ ...(cwd ? { cwd } : {}), personal })
    .then((r) => {
      console.log(`설치 완료 — codex (${r.personal ? 'personal' : 'project'})`)
      console.log(`  파일 : ${r.dest}`)
      console.log(`  호출 : ${r.invoke}`)
      console.log('  (설정이 없으면 먼저 `retry-now init`)')
    })
    .catch((e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e))
      process.exit(1)
    })
}
