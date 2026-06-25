/**
 * Tiny filesystem helpers shared across the engine. Uses node:fs/promises so the core
 * stays runtime-portable (bun and node both satisfy it).
 */
import {
  access,
  appendFile,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises'
import { dirname } from 'node:path'

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

export async function writeText(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path))
  await writeFile(path, content, 'utf8')
}

export async function readJson<T>(path: string): Promise<T | null> {
  const raw = await readText(path)
  if (raw === null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`)
}

export async function appendLine(path: string, line: string): Promise<void> {
  await ensureDir(dirname(path))
  await appendFile(path, `${line}\n`, 'utf8')
}

export function nowIso(): string {
  return new Date().toISOString()
}
