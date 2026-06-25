/**
 * Agent → driver one-way signal channel.
 *
 * Before each phase the driver writes a `pending` signal so a crashed/silent agent run is
 * detectable. The agent overwrites it as its LAST action. The driver then validates that
 * the signal matches the expected iteration+phase before trusting it.
 */
import { nowIso, readJson, writeJson } from './io.ts'
import type { Paths } from './paths.ts'
import { pad } from './paths.ts'
import type { Current, Phase, Signal } from './types.ts'

/** Reset the signal to `pending` and publish the per-reincarnation hint. */
export async function beginPhase(
  paths: Paths,
  iteration: number,
  phase: Phase,
  target?: string,
): Promise<void> {
  const current: Current =
    target !== undefined && target !== ''
      ? { iteration, padded: pad(iteration), phase, target }
      : { iteration, padded: pad(iteration), phase }
  await writeJson(paths.current, current)
  const pending: Signal = {
    iteration,
    phase,
    result: 'pending',
    report: '',
    summary: '',
    timestamp: nowIso(),
  }
  await writeJson(paths.signal, pending)
}

/**
 * Read the signal the agent emitted and validate it. Returns null when the run produced
 * no valid signal (still pending, mismatched iteration/phase, or unparseable) — the driver
 * treats that as a failed run.
 */
export async function readSignal(
  paths: Paths,
  iteration: number,
  phase: Phase,
): Promise<Signal | null> {
  const sig = await readJson<Signal>(paths.signal)
  if (!sig) return null
  if (sig.result === 'pending') return null
  if (sig.iteration !== iteration) return null
  if (sig.phase !== phase) return null
  return sig
}
