/**
 * Per-item backup restoration — the primitive `retry-now recover` rolls an unreviewed item back with.
 *
 * Backups are written by the AGENT, not the driver, so everything here treats them as untrusted
 * input. The rule under test is that anything unprovable becomes an `issue` and the caller refuses,
 * because half-restoring an item is strictly worse than refusing to restore it at all.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import { exists } from '../io.ts'
import type { ImproveItemPaths } from '../paths.ts'
import {
  backupFiles,
  dirEntries,
  readNewFileManifest,
  restoreItemBackup,
} from '../recover-backup.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'retry-now-backup-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function artifacts(): ImproveItemPaths {
  const backupDir = join(root, '.retry-now/backups/0044/item-05-5')
  return {
    key: '0044-05-review-5',
    current: join(root, '.retry-now/items/0044-05-review-5.current.json'),
    signal: join(root, '.retry-now/items/0044-05-review-5.signal.json'),
    prompt: join(root, '.retry-now/items/0044-05-review-5.prompt.md'),
    report: join(root, '.retry-now/reports/0044-05-review-5.md'),
    log: join(root, '.retry-now/logs/0044-05-review-5.log'),
    backupDir,
    newFiles: join(backupDir, 'NEW_FILES.txt'),
  }
}

async function put(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body, 'utf8')
}

test('dirEntries: a missing directory reads as empty, never throws', async () => {
  expect(await dirEntries(join(root, 'nope'))).toEqual([])
  await mkdir(join(root, 'here'), { recursive: true })
  await put(join(root, 'here/a.txt'), 'a')
  expect(await dirEntries(join(root, 'here'))).toEqual(['a.txt'])
})

test('backupFiles: a missing or non-directory backup path reads as empty', async () => {
  expect(await backupFiles(join(root, 'nope'))).toEqual([])
  await put(join(root, 'a-file'), 'not a directory')
  expect(await backupFiles(join(root, 'a-file'))).toEqual([])
})

test('backupFiles: walks nested paths and excludes the manifest itself', async () => {
  const item = artifacts()
  await put(join(item.backupDir, 'src/deep/nested.rs'), 'nested\n')
  await put(join(item.backupDir, 'top.rs'), 'top\n')
  await put(item.newFiles, 'src/created.rs\n')
  expect(await backupFiles(item.backupDir)).toEqual([
    'src/deep/nested.rs',
    'top.rs',
  ])
})

test('readNewFileManifest: tolerates comments, blanks, and backslashes', async () => {
  const item = artifacts()
  await put(
    item.newFiles,
    '# created by this item\n\nsrc/one.rs\r\nsrc\\two.rs\n   \n',
  )
  expect(await readNewFileManifest(item.newFiles)).toEqual([
    'src/one.rs',
    'src/two.rs',
  ])
  expect(await readNewFileManifest(join(root, 'absent.txt'))).toEqual([])
})

test('restores modified files and deletes created files', async () => {
  const item = artifacts()
  await put(join(root, 'src/update.rs'), 'item 5 partial\n')
  await put(join(root, 'src/brand_new.rs'), 'created\n')
  await put(join(item.backupDir, 'src/update.rs'), 'approved\n')
  await put(item.newFiles, 'src/brand_new.rs\n')

  const result = await restoreItemBackup(root, item)
  expect(result.issue).toBeNull()
  expect(result.restored).toEqual(['src/update.rs'])
  expect(result.deleted).toEqual(['src/brand_new.rs'])
  expect(await readFile(join(root, 'src/update.rs'), 'utf8')).toBe('approved\n')
  expect(await exists(join(root, 'src/brand_new.rs'))).toBe(false)
})

test('a backed-up path WINS over a manifest claiming the item created it', async () => {
  // The backup proves the file existed beforehand, so deleting it would destroy pre-existing content.
  const item = artifacts()
  await put(join(root, 'src/both.rs'), 'item 5 rewrote this\n')
  await put(join(item.backupDir, 'src/both.rs'), 'existed before\n')
  await put(item.newFiles, 'src/both.rs\n')

  const result = await restoreItemBackup(root, item)
  expect(result.issue).toBeNull()
  expect(result.deleted).toEqual([])
  expect(result.restored).toEqual(['src/both.rs'])
  expect(await readFile(join(root, 'src/both.rs'), 'utf8')).toBe(
    'existed before\n',
  )
})

test('restores a file the item DELETED', async () => {
  const item = artifacts()
  await put(join(item.backupDir, 'src/gone.rs'), 'restore me\n')
  const result = await restoreItemBackup(root, item)
  expect(result.issue).toBeNull()
  expect(await readFile(join(root, 'src/gone.rs'), 'utf8')).toBe('restore me\n')
})

test('REFUSES an unsafe manifest path without touching anything', async () => {
  const item = artifacts()
  await put(join(root, 'src/keep.rs'), 'untouched\n')
  await put(join(item.backupDir, 'src/keep.rs'), 'approved\n')
  await put(item.newFiles, '../escape.rs\n')

  const result = await restoreItemBackup(root, item)
  expect(result.issue).toContain('unsafe repository-relative path')
  expect(result.restored).toEqual([])
  expect(result.deleted).toEqual([])
  expect(await readFile(join(root, 'src/keep.rs'), 'utf8')).toBe('untouched\n')
})

test('REFUSES a backup path that escapes the configured per-package scope', async () => {
  const item = artifacts()
  await put(join(item.backupDir, 'other/pkg.rs'), 'approved\n')
  const result = await restoreItemBackup(root, item, 'crates/mine')
  expect(result.issue).toContain('escapes the configured scope crates/mine')
  expect(result.restored).toEqual([])
})

test('accepts a backup path inside the configured scope', async () => {
  const item = artifacts()
  await put(join(item.backupDir, 'crates/mine/lib.rs'), 'approved\n')
  const result = await restoreItemBackup(root, item, 'crates/mine/')
  expect(result.issue).toBeNull()
  expect(result.restored).toEqual(['crates/mine/lib.rs'])
})

test('REFUSES when a created path is really a directory (deletion cannot be trusted)', async () => {
  const item = artifacts()
  await mkdir(join(root, 'src/a-directory/inner'), { recursive: true })
  await put(join(root, 'src/a-directory/inner/keep.rs'), 'keep\n')
  await put(item.newFiles, 'src/a-directory\n')

  const result = await restoreItemBackup(root, item)
  expect(result.issue).toContain('could not delete a file the item created')
  // The directory and its contents survive the refusal.
  expect(await exists(join(root, 'src/a-directory/inner/keep.rs'))).toBe(true)
})

test('REFUSES when a backed-up file cannot be written back', async () => {
  const item = artifacts()
  // The repository has a DIRECTORY where the backup holds a file, so the copy cannot succeed.
  await mkdir(join(root, 'src/update.rs'), { recursive: true })
  await put(join(item.backupDir, 'src/update.rs'), 'approved\n')

  const result = await restoreItemBackup(root, item)
  expect(result.issue).toContain('could not restore a backed-up file')
  expect(result.restored).toEqual([])
})
