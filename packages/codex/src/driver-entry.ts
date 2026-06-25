#!/usr/bin/env bun
/**
 * Self-contained driver entry. The Codex `$retry-now` skill (installed by this package) bakes
 * this file's absolute path and launches it with bun — no global CLI install required. Thin
 * shim over the shared core driver CLI.
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
