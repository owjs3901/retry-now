/**
 * `@retry-now/core` filesystem helpers — the never-throw I/O boundary.
 *
 * Every read helper must degrade to a null/empty/false sentinel instead of throwing, and every
 * write helper must create its parent directory first, so the driver can read/write loop state
 * without sprinkling try/catch at every call site. These tests exercise every branch (present vs
 * absent, valid vs malformed JSON) against a real temp dir.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import {
  appendLine,
  ensureDir,
  exists,
  nowIso,
  readJson,
  readText,
  writeJson,
  writeText,
} from '../io.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'retry-now-io-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('exists returns true for a present path and false for an absent one', async () => {
  const f = join(dir, 'present.txt')
  await writeText(f, 'hi')
  expect(await exists(f)).toBe(true)
  expect(await exists(join(dir, 'nope.txt'))).toBe(false)
})

test('ensureDir creates nested directories idempotently', async () => {
  const nested = join(dir, 'a', 'b', 'c')
  await ensureDir(nested)
  await ensureDir(nested) // second call must not throw
  expect(await exists(nested)).toBe(true)
})

test('writeText creates the parent dir and round-trips through readText', async () => {
  const f = join(dir, 'deep', 'note.txt')
  await writeText(f, 'content here')
  expect(await readText(f)).toBe('content here')
})

test('readText returns null for a missing file (never throws)', async () => {
  expect(await readText(join(dir, 'missing.txt'))).toBeNull()
})

test('writeJson writes pretty JSON with a trailing newline; readJson parses it back', async () => {
  const f = join(dir, 'data.json')
  await writeJson(f, { a: 1, b: ['x'] })
  const raw = await readFile(f, 'utf8')
  expect(raw).toBe('{\n  "a": 1,\n  "b": [\n    "x"\n  ]\n}\n')
  expect(await readJson<{ a: number; b: string[] }>(f)).toEqual({
    a: 1,
    b: ['x'],
  })
})

test('readJson returns null for a missing file and for malformed JSON', async () => {
  expect(await readJson(join(dir, 'absent.json'))).toBeNull()
  const bad = join(dir, 'bad.json')
  await writeText(bad, '{ not valid json')
  expect(await readJson(bad)).toBeNull()
})

test('appendLine creates the file and appends one line per call', async () => {
  const f = join(dir, 'log', 'history.jsonl')
  await appendLine(f, 'first')
  await appendLine(f, 'second')
  expect(await readText(f)).toBe('first\nsecond\n')
})

test('nowIso returns a parseable ISO-8601 timestamp', () => {
  const iso = nowIso()
  expect(typeof iso).toBe('string')
  expect(new Date(iso).toISOString()).toBe(iso)
})
