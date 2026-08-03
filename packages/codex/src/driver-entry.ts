#!/usr/bin/env bun
/**
 * Self-contained driver entry. The Codex `$retry-now` skill (installed by this package) bakes
 * this file's absolute path and launches it with bun — no global CLI install required. Thin
 * shim over the shared core driver CLI.
 */
import { runDriverCli } from '@retry-now/core'

export async function runDriverEntry(
  argv: readonly string[],
  runner: (args: readonly string[]) => Promise<number> = runDriverCli,
  logError: (line: string) => void = console.error,
): Promise<number> {
  try {
    return await runner(argv)
  } catch (error) {
    logError(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    )
    return 1
  }
}

if (import.meta.main) process.exit(await runDriverEntry(process.argv))
