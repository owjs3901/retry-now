#!/usr/bin/env bun
/**
 * `@retry-now/claude` — Claude Code integration.
 *
 * `bunx @retry-now/claude [--cwd <path>] [--personal]` installs a `/retry-now` slash command
 * into `.claude/commands/retry-now.md` (project) or `~/.claude/commands/retry-now.md` (personal)
 * with this package's driver baked in. Also exported as a programmatic `install()`.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type FrontendInstallResult, installFrontend } from '@retry-now/core'

// Prefer the compiled sibling when running from dist (published), else the .ts source (dev).
// bun runs either; the baked command just needs a path that exists in the current layout.
const here = dirname(fileURLToPath(import.meta.url))
const compiledDriver = join(here, 'driver-entry.js')
const DRIVER = existsSync(compiledDriver)
  ? compiledDriver
  : join(here, 'driver-entry.ts')

export function install(
  opts: { cwd?: string; personal?: boolean } = {},
): Promise<FrontendInstallResult> {
  return installFrontend('claude', `bun "${DRIVER}"`, opts)
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const personal = argv.includes('--personal')
  const ci = argv.indexOf('--cwd')
  const cwd = ci >= 0 ? argv[ci + 1] : undefined
  install({ ...(cwd ? { cwd } : {}), personal })
    .then((r) => {
      console.log(`설치 완료 — claude (${r.personal ? 'personal' : 'project'})`)
      console.log(`  파일 : ${r.dest}`)
      console.log(`  호출 : ${r.invoke}`)
      console.log('  (설정이 없으면 먼저 `retry-now init`)')
    })
    .catch((e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e))
      process.exit(1)
    })
}
