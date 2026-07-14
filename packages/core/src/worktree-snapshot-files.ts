import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

type SnapshotStat = {
  readonly mode: number
  isSymbolicLink(): boolean
  isFile(): boolean
}

export type SnapshotFiles = {
  lstat(path: string): Promise<SnapshotStat>
  readFile(path: string): Promise<Buffer>
  readlink(path: string): Promise<string>
  rm(
    path: string,
    options: { recursive: boolean; force: boolean },
  ): Promise<unknown>
  mkdir(path: string, options: { recursive: boolean }): Promise<unknown>
  writeFile(path: string, content: Buffer): Promise<unknown>
  chmod(path: string, mode: number): Promise<unknown>
  symlink(target: string, path: string): Promise<unknown>
  rename(oldPath: string, newPath: string): Promise<unknown>
}

export const DEFAULT_SNAPSHOT_FILES = {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} satisfies SnapshotFiles

export type SnapshotEntry =
  | { readonly kind: 'missing' }
  | { readonly kind: 'file'; readonly content: Buffer; readonly mode: number }
  | { readonly kind: 'symlink'; readonly target: string }
  | { readonly kind: 'directory' }

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export async function captureSnapshotEntry(
  path: string,
  files: SnapshotFiles,
): Promise<SnapshotEntry> {
  try {
    const stat = await files.lstat(path)
    if (stat.isSymbolicLink()) {
      return { kind: 'symlink', target: await files.readlink(path) }
    }
    if (stat.isFile()) {
      return {
        kind: 'file',
        content: await files.readFile(path),
        mode: stat.mode & 0o777,
      }
    }
    return { kind: 'directory' }
  } catch (error) {
    if (isMissing(error)) return { kind: 'missing' }
    throw error
  }
}

export async function restoreSnapshotEntry(
  root: string,
  path: string,
  entry: SnapshotEntry | undefined,
  files: SnapshotFiles,
): Promise<void> {
  const absolute = resolve(root, path)
  await files.rm(absolute, { recursive: true, force: true })
  if (entry === undefined || entry.kind === 'missing') return
  await files.mkdir(dirname(absolute), { recursive: true })
  switch (entry.kind) {
    case 'file':
      await files.writeFile(absolute, entry.content)
      await files.chmod(absolute, entry.mode)
      return
    case 'symlink':
      await files.symlink(entry.target, absolute)
      return
    case 'directory':
      await files.mkdir(absolute, { recursive: true })
      return
  }
}
