/**
 * Restoring ONE improvement item from its own per-item backup directory.
 *
 * This is the primitive the whole recovery story rests on, and it works because of a single
 * structural property: both stages of item K share one backup directory, filled BEFORE item K edited
 * anything, so its contents are exactly `HEAD + item(1..K-1)`. Restoring from it therefore strips
 * item K's changes and NOTHING else — even when an earlier item in the same batch edited the same
 * file. That is what makes "roll back only the unreviewed item" a provable operation rather than a
 * guess, and it is why the layout must not be collapsed into a per-stage or per-batch backup.
 *
 * Backups are written by the AGENT (the implement prompt instructs it), so this code treats them as
 * untrusted input: every path is validated as a safe repository-relative path and, in per-package
 * mode, rejected unless it falls inside the configured scope. Anything unprovable becomes an `issue`
 * and the caller refuses rather than half-restoring.
 */
import type { Dirent } from 'node:fs'
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { isSafeGitListedPath } from './git.ts'
import { readText } from './io.ts'
import { type ImproveItemPaths, NEW_FILES_MANIFEST } from './paths.ts'

export interface BackupRestore {
  /** non-null when nothing may be trusted; the caller must refuse and change no more */
  readonly issue: string | null
  /** repository-relative paths restored from the backup */
  readonly restored: readonly string[]
  /** repository-relative paths deleted because the item created them */
  readonly deleted: readonly string[]
}

/** Immediate entry names in `dir`, or `[]` when it does not exist. */
export async function dirEntries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

/**
 * Every file under `dir`, as repository-relative paths with forward slashes. The backup mirrors the
 * repository layout, so a file's path relative to the backup root IS its repository path.
 */
export async function backupFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  async function walk(current: string, prefix: string): Promise<void> {
    let entries: Dirent<string>[]
    try {
      entries = await readdir(current, {
        withFileTypes: true,
        encoding: 'utf8',
      })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        await walk(join(current, entry.name), rel)
        continue
      }
      if (!entry.isFile()) continue
      if (rel === NEW_FILES_MANIFEST) continue // the manifest is metadata, not repository content
      found.push(rel)
    }
  }
  await walk(dir, '')
  return found.sort()
}

/**
 * Repository-relative paths an item recorded as newly CREATED. Blank lines and `#` comments are
 * tolerated so a hand-edited manifest still parses.
 */
export async function readNewFileManifest(path: string): Promise<string[]> {
  const raw = await readText(path)
  if (raw === null) return []
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.replace(/\\/g, '/'))
}

function scopeIssue(path: string, scope: string): string | null {
  // Containment only, deliberately permitting glob metacharacters: these paths name repository files
  // the item backed up or created, they are only ever `resolve()`d for a direct copy/delete (never
  // expanded as a glob or a pathspec), and the scope check below plus the traversal/absolute/
  // drive-letter/control-character guards inside the predicate keep every one of them inside the
  // configured scope. Rejecting `app/blog/[slug]/page.tsx` here would refuse the ROLLBACK of any
  // item that touched a Next.js/SvelteKit/Remix route file — the failure mode that leaves an
  // unreviewed change in the tree, which is strictly worse than copying a bracketed filename.
  if (!isSafeGitListedPath(path)) {
    return `unsafe repository-relative path in the item backup: ${path}`
  }
  const normalized = scope.replace(/\\/g, '/').replace(/\/$/, '')
  if (
    normalized !== '' &&
    path !== normalized &&
    !path.startsWith(`${normalized}/`)
  ) {
    return `item backup path escapes the configured scope ${normalized}: ${path}`
  }
  return null
}

/**
 * Undo exactly one item: delete the files it created, then restore the files it modified.
 *
 * Deletions run FIRST so that a path appearing in BOTH the manifest and the backup ends up restored.
 * The backup is the stronger evidence — it proves the file existed beforehand — so it must win over
 * a manifest entry claiming the item created it.
 */
export async function restoreItemBackup(
  root: string,
  artifacts: ImproveItemPaths,
  scope = '',
): Promise<BackupRestore> {
  const created = await readNewFileManifest(artifacts.newFiles)
  const backed = await backupFiles(artifacts.backupDir)
  for (const path of [...created, ...backed]) {
    const issue = scopeIssue(path, scope)
    if (issue !== null) return { issue, restored: [], deleted: [] }
  }

  const backedSet = new Set(backed)
  const deleted: string[] = []
  try {
    for (const path of created) {
      if (backedSet.has(path)) continue
      await rm(resolve(root, path), { recursive: false, force: true })
      deleted.push(path)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      issue: `could not delete a file the item created: ${message}`,
      restored: [],
      deleted,
    }
  }

  const restored: string[] = []
  try {
    for (const path of backed) {
      const destination = resolve(root, path)
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(join(artifacts.backupDir, path), destination)
      restored.push(path)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      issue: `could not restore a backed-up file: ${message}`,
      restored,
      deleted,
    }
  }

  return { issue: null, restored, deleted }
}
