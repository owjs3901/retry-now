/**
 * Project-local single-instance guard for the loop driver.
 *
 * Every project has its OWN `.retry-now/` — state is never shared across projects, so two drivers
 * on DIFFERENT projects can NEVER contend (each only ever touches its own folder). The one and only
 * way to corrupt state is running TWO drivers on the SAME project's single `.retry-now/`. This lock
 * makes that impossible: a driver acquires a project-local `driver.lock` at startup, and a second
 * driver on the same project is refused. A lock left behind by a crashed / killed driver (a dead
 * pid) is treated as stale and reclaimed, so a hard kill never wedges the next run.
 *
 * Note for anyone auditing running processes: seeing several `bun` driver processes at once is
 * NORMAL when several projects run in parallel — one per project, each isolated. That is not
 * contention, and those processes must not be killed. Only a same-project duplicate is a problem,
 * and this guard already prevents it.
 */
import { readFile, rm, writeFile } from 'node:fs/promises'

import { nowIso } from './io.ts'

export interface DriverLock {
  readonly pid: number
  readonly root: string
  readonly startedAt: string
}

/**
 * Best-effort, cross-platform liveness check via signal 0: it never actually signals the process,
 * only probes whether it exists. `EPERM` means the process exists but is owned by someone else —
 * still alive — so only a non-`EPERM` throw (e.g. `ESRCH`) counts as dead.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function readLock(lockPath: string): Promise<DriverLock | null> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(lockPath, 'utf8'))
  } catch {
    return null // missing or unparseable → treat as no valid holder
  }
  if (
    typeof raw === 'object' &&
    raw !== null &&
    typeof (raw as DriverLock).pid === 'number' &&
    typeof (raw as DriverLock).root === 'string' &&
    typeof (raw as DriverLock).startedAt === 'string'
  ) {
    const lock = raw as DriverLock
    return { pid: lock.pid, root: lock.root, startedAt: lock.startedAt }
  }
  return null
}

export type LockResult =
  { readonly ok: true } | { readonly ok: false; readonly holder: DriverLock }

/**
 * Acquire the project-local driver lock. Returns `{ ok: true }` when acquired, or
 * `{ ok: false, holder }` when a LIVE driver already holds it — i.e. a second run on the SAME
 * project, which is exactly the case that would contend. A stale lock (dead holder, unreadable, or
 * our own leftover) is reclaimed. `alive` is injectable so the acquire logic is unit-testable.
 */
export async function acquireDriverLock(
  lockPath: string,
  root: string,
  alive: (pid: number) => boolean = isPidAlive,
): Promise<LockResult> {
  const payload = `${JSON.stringify({ pid: process.pid, root, startedAt: nowIso() })}\n`
  try {
    // `wx` = create-and-fail-if-exists: an atomic test-and-set, so two drivers racing to start on
    // the same project can never both believe they acquired it.
    await writeFile(lockPath, payload, { flag: 'wx' })
    return { ok: true }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  const holder = await readLock(lockPath)
  if (holder !== null && holder.pid !== process.pid && alive(holder.pid)) {
    return { ok: false, holder }
  }
  await writeFile(lockPath, payload) // reclaim a stale / own lock
  return { ok: true }
}

/**
 * Release the lock, but ONLY if we still own it (pid match) or it is already gone/unreadable — so a
 * driver that reclaimed a stale lock is never deleted out from under it by the previous owner's
 * late cleanup.
 */
export async function releaseDriverLock(lockPath: string): Promise<void> {
  const holder = await readLock(lockPath)
  if (holder === null || holder.pid === process.pid) {
    await rm(lockPath, { force: true })
  }
}
