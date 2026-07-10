/**
 * `@retry-now/core` single-instance guard — proves the ONLY contention case (a 2nd driver on the
 * SAME project) is refused, while stale locks from killed drivers are reclaimed so a hard kill never
 * wedges the next run. Drivers on DIFFERENT projects use different lock paths and never interact.
 *
 * Real temp files back the happy paths; the liveness check is injected so "held by a live driver"
 * vs "stale/dead" are exercised deterministically.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import { acquireDriverLock, isPidAlive, releaseDriverLock } from '../lock.ts'

interface RawLock {
  pid: number
  root: string
  startedAt: string
}

const ALIVE = (): boolean => true
const DEAD = (): boolean => false

let dir: string
let lockPath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'retry-now-lock-'))
  lockPath = join(dir, 'driver.lock')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function readRaw(): Promise<RawLock> {
  return JSON.parse(await readFile(lockPath, 'utf8')) as RawLock
}

test('isPidAlive: true for our own process, false for a definitely-absent pid', () => {
  expect(isPidAlive(process.pid)).toBe(true)
  expect(isPidAlive(2_147_483_646)).toBe(false)
})

test('acquireDriverLock: takes a free lock and records our pid + root', async () => {
  const res = await acquireDriverLock(lockPath, dir)
  expect(res.ok).toBe(true)
  const held = await readRaw()
  expect(held.pid).toBe(process.pid)
  expect(held.root).toBe(dir)
  expect(typeof held.startedAt).toBe('string')
})

test('acquireDriverLock: REFUSES when a live driver (different pid) already holds it', async () => {
  await writeFile(
    lockPath,
    JSON.stringify({ pid: 999_999, root: dir, startedAt: 't' }),
  )
  const res = await acquireDriverLock(lockPath, dir, ALIVE)
  expect(res.ok).toBe(false)
  if (!res.ok) {
    expect(res.holder.pid).toBe(999_999)
    expect(res.holder.root).toBe(dir)
  }
})

test('acquireDriverLock: reclaims a STALE lock left by a dead driver', async () => {
  await writeFile(
    lockPath,
    JSON.stringify({ pid: 999_999, root: dir, startedAt: 't' }),
  )
  const res = await acquireDriverLock(lockPath, dir, DEAD)
  expect(res.ok).toBe(true)
  expect((await readRaw()).pid).toBe(process.pid) // overwritten with ours
})

test('acquireDriverLock: reclaims an unreadable/garbage lock (alive never consulted)', async () => {
  await writeFile(lockPath, '{ not valid json')
  const res = await acquireDriverLock(lockPath, dir, ALIVE)
  expect(res.ok).toBe(true)
})

test('acquireDriverLock: reclaims a lock whose JSON has wrong-typed fields', async () => {
  await writeFile(lockPath, JSON.stringify({ pid: 'nope', root: 5 }))
  const res = await acquireDriverLock(lockPath, dir, ALIVE)
  expect(res.ok).toBe(true)
})

test('acquireDriverLock: reclaims our OWN leftover lock without consulting alive', async () => {
  await writeFile(
    lockPath,
    JSON.stringify({ pid: process.pid, root: dir, startedAt: 't' }),
  )
  let consulted = false
  const res = await acquireDriverLock(lockPath, dir, () => {
    consulted = true
    return true
  })
  expect(res.ok).toBe(true)
  expect(consulted).toBe(false) // short-circuits: holder.pid === process.pid
})

test('acquireDriverLock: a non-EEXIST fs error propagates (never silently swallowed)', async () => {
  const badPath = join(dir, 'no-such-subdir', 'driver.lock') // missing parent → ENOENT
  await expect(acquireDriverLock(badPath, dir)).rejects.toThrow()
})

test('releaseDriverLock: removes the lock when we own it', async () => {
  await acquireDriverLock(lockPath, dir)
  await releaseDriverLock(lockPath)
  await expect(readFile(lockPath, 'utf8')).rejects.toThrow()
})

test('releaseDriverLock: is a safe no-op when there is no lock file', async () => {
  await releaseDriverLock(lockPath)
  await expect(readFile(lockPath, 'utf8')).rejects.toThrow()
})

test('releaseDriverLock: does NOT delete a lock a different (reclaiming) driver now owns', async () => {
  await writeFile(
    lockPath,
    JSON.stringify({ pid: 999_999, root: dir, startedAt: 't' }),
  )
  await releaseDriverLock(lockPath)
  expect((await readRaw()).pid).toBe(999_999) // untouched
})
