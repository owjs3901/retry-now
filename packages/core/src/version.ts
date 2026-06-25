/**
 * Single source of truth for the running retry-now version.
 *
 * Read from THIS package's `package.json` at startup so the number shown to the user can never
 * drift from the package metadata. Best-effort: any failure falls back to "0.0.0" rather than
 * crashing a loop just to print a banner. Everything runs straight from source (bun, no build),
 * so the path resolves to the real package root in every install layout.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function readVersion(): string {
  try {
    const pkgPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'package.json',
    )
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      version?: unknown
    }
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** The retry-now version, sourced from `@retry-now/core`'s `package.json`. */
export const VERSION = readVersion()
