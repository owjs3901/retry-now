/**
 * `@retry-now/opencode` — opencode plugin.
 *
 * Registers the `/retry-now` slash command via the stable `config` hook (opencode plugins
 * cannot render interactive forms nor register code-executing commands, but they CAN inject
 * a command definition at load time — verified against @opencode-ai/plugin 1.17.x).
 *
 * The command body (shared with `retry-now install opencode`) CONDUCTS THE SETUP INTERVIEW
 * (scope / analysis / direction / completion / threshold) when no config exists, writes
 * `.retry-now/config.json`, then runs the loop — so the user is always asked, never dropped
 * straight into a run. The bundled driver path + project root are baked at load time, so no
 * global CLI install is required.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Plugin } from '@opencode-ai/plugin'
import { buildFrontendBody } from '@retry-now/core'

// Absolute path to the driver entry, resolved relative to this module. Prefer the compiled
// sibling when loaded from dist (published), else the .ts source (dev) — bun runs either.
const here = dirname(fileURLToPath(import.meta.url))
const compiledDriver = join(here, 'driver-entry.js')
const DRIVER_ENTRY = existsSync(compiledDriver)
  ? compiledDriver
  : join(here, 'driver-entry.ts')

// The template (interview-then-run body, shared with the install command) is sent to the
// opencode agent in English (token-efficient); the agent talks back in the user's language.
function buildTemplate(root: string): string {
  return buildFrontendBody('opencode', `bun "${DRIVER_ENTRY}" --cwd "${root}"`)
}

export const RetryNowPlugin: Plugin = async ({ worktree, directory }) => {
  const root = worktree || directory
  return {
    config: async (config) => {
      config.command ??= {}
      if (!config.command['retry-now']) {
        config.command['retry-now'] = {
          template: buildTemplate(root),
          description: '지금 바로 윤회 — 자율 개선 윤회(분석→개선→수렴) 시작',
        }
      }
    },
  }
}

export default RetryNowPlugin
