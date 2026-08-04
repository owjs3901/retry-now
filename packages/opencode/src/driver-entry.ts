#!/usr/bin/env bun
/**
 * Self-contained driver entry the opencode plugin hands to the in-session agent.
 *
 * The plugin bakes this file's absolute path into the `/retry-now` command template, so the
 * agent launches it directly with bun — no global `@retry-now/cli` install required. It
 * streams only concise phase-boundary progress to stdout (verbose agent transcripts go to
 * `.retry-now/logs/`), so it is safe to run in the foreground of an opencode bash tool call.
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
