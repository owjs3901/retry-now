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
 * The file is a personal/global command, while the tool context supplies the active
 * project directory at execution time. It is rewritten only when its content changes,
 * so repeated launches don't churn.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Plugin } from '@opencode-ai/plugin'
import { buildPluginCommandFile } from '@retry-now/core'

import { AutoStartCoordinator } from './native/auto-start.ts'
import { LoopController } from './native/controller.ts'
import {
  isSessionIdleEvent,
  retryNowCommandSessionID,
} from './native/plugin-events.ts'
import { createRetryNowTools, RetryNowToolRuntime } from './tools.ts'

let loopController: LoopController | undefined

/**
 * Materialise (or refresh) the opencode command file that exposes `/retry-now`.
 * Best-effort: never let a filesystem hiccup break opencode startup.
 */
export function ensureCommandFile(homeDirectory?: string): void {
  try {
    const file = buildPluginCommandFile()
    const dest = join(homeDirectory ?? homedir(), file.homePath)
    if (existsSync(dest) && readFileSync(dest, 'utf8') === file.content) return
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, file.content, 'utf8')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`retry-now command registration failed: ${detail}`)
  }
}

// Run at import: the earliest point, before opencode / oh-my-openagent scan the
// command directories to build their slash-command registries.
ensureCommandFile()

export const RetryNowPlugin: Plugin = async ({ client, directory }) => {
  const controller = loopController ?? new LoopController(client)
  loopController = controller
  const runtime = new RetryNowToolRuntime({ client, controller })
  // Start the loop from the `/retry-now` command itself — no agent-callable tool. Bus events fire
  // for every session regardless of the active (possibly curated) agent, so `/retry-now` works
  // everywhere. `command.executed` records the parent session; `session.idle` is when we actually
  // start, so STEP 1 has already written `.retry-now/config.json`. `start()` is idempotent.
  const autoStart = new AutoStartCoordinator({
    start: (parentSessionID) =>
      runtime.start({}, { directory, sessionID: parentSessionID }).then(() => {
        // discard the human-facing string; the coordinator confirms via isActive
      }),
    isActive: () => controller.getLoopStatus(directory) !== undefined,
    log: (line) => console.error(line),
  })
  return {
    event: async ({ event }) => {
      controller.handleEvent(event)
      const commandSessionID = retryNowCommandSessionID(event)
      if (commandSessionID !== undefined) {
        await autoStart.onCommandExecuted(commandSessionID)
        return
      }
      if (isSessionIdleEvent(event)) await autoStart.onIdle()
    },
    tool: createRetryNowTools(runtime),
  }
}

export default RetryNowPlugin
