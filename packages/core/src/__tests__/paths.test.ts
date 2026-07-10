/**
 * `@retry-now/core` path layout — the single source of truth for the `.retry-now/` tree.
 *
 * Two invariants matter: SHARED files (config/prompts/gitignore/readme/STOP/driver.lock) always
 * live at `.retry-now/`, while STATEFUL files (state/signal/current/history/ledger/summary/reports/
 * logs) relocate under `.retry-now/targets/<slug>/` for a per-package 윤회. `slugifyTarget` must make
 * any path filesystem-safe, and `pad` must zero-pad iteration ids for stable file names.
 */
import { join } from 'node:path'

import { expect, test } from 'bun:test'

import { DIR, pad, resolvePaths, slugifyTarget } from '../paths.ts'

test('slugifyTarget makes a nested path filesystem-safe', () => {
  expect(slugifyTarget('crates/vespera_core')).toBe('crates__vespera_core')
  expect(slugifyTarget('packages\\cli')).toBe('packages__cli')
  expect(slugifyTarget('a/b\\c')).toBe('a__b__c')
  expect(slugifyTarget('weird name!@#')).toBe('weird_name___')
})

test('pad zero-pads to width 4 and leaves longer numbers intact', () => {
  expect(pad(0)).toBe('0000')
  expect(pad(12)).toBe('0012')
  expect(pad(1234)).toBe('1234')
  expect(pad(12345)).toBe('12345')
})

test('resolvePaths (whole-repo): every file sits directly under <root>/.retry-now', () => {
  const root = join('/tmp', 'proj')
  const p = resolvePaths(root)
  const base = join(root, DIR)
  expect(p.root).toBe(root)
  expect(p.dir).toBe(base)
  expect(p.config).toBe(join(base, 'config.json'))
  expect(p.state).toBe(join(base, 'state.json'))
  expect(p.reportsDir).toBe(join(base, 'reports'))
  expect(p.analyzePrompt).toBe(join(base, 'prompts', 'analyze.md'))
  expect(p.driverLock).toBe(join(base, 'driver.lock'))
})

test('resolvePaths (per-package): stateful files relocate under targets/<slug>, shared stay at root', () => {
  const root = join('/tmp', 'proj')
  const base = join(root, DIR)
  const stateDir = join(base, 'targets', 'pkg__a')
  const p = resolvePaths(root, 'pkg__a')
  // SHARED stay at the top-level dir...
  expect(p.config).toBe(join(base, 'config.json'))
  expect(p.gitignore).toBe(join(base, '.gitignore'))
  expect(p.stop).toBe(join(base, 'STOP'))
  expect(p.driverLock).toBe(join(base, 'driver.lock'))
  // ...STATEFUL relocate under the target slug.
  expect(p.state).toBe(join(stateDir, 'state.json'))
  expect(p.signal).toBe(join(stateDir, 'signal.json'))
  expect(p.reportsDir).toBe(join(stateDir, 'reports'))
  expect(p.analyzePrompt).toBe(join(stateDir, 'prompts', 'analyze.md'))
})
