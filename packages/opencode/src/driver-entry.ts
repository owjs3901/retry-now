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

runDriverCli(process.argv)
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    )
    process.exit(1)
  })
