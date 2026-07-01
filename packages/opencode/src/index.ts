/**
 * `@retry-now/opencode` — opencode plugin.
 *
 * Registers the `/retry-now` command by writing opencode's native command file at
 * load time: `~/.config/opencode/command/retry-now.md`.
 *
 * Why a command FILE instead of a `config` hook: opencode does NOT reliably turn a
 * plugin `config` hook's `config.command` mutation into a usable slash command.
 * Other plugins — notably `oh-my-openagent` — rebuild `config.command` WHOLESALE in
 * their own `config` hook (from builtins + a fresh scan of the command directories)
 * and drop any key an earlier plugin injected, so a hook-injected `/retry-now`
 * silently disappears. Both opencode AND oh-my-openagent scan the command dirs, so a
 * command FILE is always picked up. It is written synchronously at import — the
 * earliest point, before any command-directory scan runs — so `/retry-now` appears
 * on the same launch.
 *
 * The bundled driver path is baked into the file, so no global CLI install is
 * needed. The file is a personal/global command (no `--cwd`), so `/retry-now` runs
 * in whichever project opencode is open in. It is rewritten only when its content
 * changes (e.g. an upgrade moved the driver path), so repeated launches don't churn.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Plugin } from '@opencode-ai/plugin'
import { buildFrontend } from '@retry-now/core'

// Absolute path to the driver entry, resolved relative to this module. Prefer the
// compiled sibling when loaded from dist (published), else the .ts source (dev).
const here = dirname(fileURLToPath(import.meta.url))
const compiledDriver = join(here, 'driver-entry.js')
const DRIVER_ENTRY = existsSync(compiledDriver)
  ? compiledDriver
  : join(here, 'driver-entry.ts')

/**
 * Materialise (or refresh) the opencode command file that exposes `/retry-now`.
 * Best-effort: never let a filesystem hiccup break opencode startup.
 */
function ensureCommandFile(): void {
  try {
    // Personal/global driver (no `--cwd`): the loop runs in opencode's current cwd.
    const file = buildFrontend('opencode', `bun "${DRIVER_ENTRY}"`)
    const dest = join(homedir(), file.homePath)
    if (existsSync(dest) && readFileSync(dest, 'utf8') === file.content) return
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, file.content, 'utf8')
  } catch {
    // swallow — trigger installation is best-effort, never fatal
  }
}

// Run at import: the earliest point, before opencode / oh-my-openagent scan the
// command directories to build their slash-command registries.
ensureCommandFile()

export const RetryNowPlugin: Plugin = async () => ({})

export default RetryNowPlugin
