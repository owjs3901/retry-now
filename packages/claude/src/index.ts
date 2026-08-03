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
export function resolveDriverPath(
  sourceUrl = import.meta.url,
  fileExists: (path: string) => boolean = existsSync,
): string {
  const here = dirname(fileURLToPath(sourceUrl))
  const compiledDriver = join(here, 'driver-entry.js')
  return fileExists(compiledDriver)
    ? compiledDriver
    : join(here, 'driver-entry.ts')
}

const DRIVER = resolveDriverPath()

export function install(
  opts: { cwd?: string; personal?: boolean } = {},
): Promise<FrontendInstallResult> {
  return installFrontend('claude', `bun "${DRIVER}"`, opts)
}

export async function runInstallerCli(
  argv: readonly string[],
  installer: typeof install = install,
  log: (line: string) => void = console.log,
  logError: (line: string) => void = console.error,
): Promise<number> {
  const personal = argv.includes('--personal')
  const ci = argv.indexOf('--cwd')
  const cwd = ci >= 0 ? argv[ci + 1] : undefined
  try {
    const result = await installer({ ...(cwd ? { cwd } : {}), personal })
    log(`설치 완료 — claude (${result.personal ? 'personal' : 'project'})`)
    log(`  파일 : ${result.dest}`)
    log(`  호출 : ${result.invoke}`)
    log('  (설정이 없으면 먼저 `retry-now init`)')
    return 0
  } catch (error) {
    logError(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (import.meta.main) process.exit(await runInstallerCli(process.argv.slice(2)))
