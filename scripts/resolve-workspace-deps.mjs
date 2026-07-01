#!/usr/bin/env node
/**
 * resolve-workspace-deps.mjs — rewrite `workspace:` protocol dependency specs
 * in a package.json to concrete versions, read from the LIVE `version` field of
 * every packages/*\/package.json in this monorepo.
 *
 * Why this exists:
 *   `bun pm pack` rewrites `workspace:*`, but it resolves the version from
 *   bun.lock's cached workspace versions — which go STALE after
 *   `changepacks update` bumps each package.json `version` without re-syncing
 *   the lockfile. That shipped tarballs pinning `@retry-now/core@0.1.0` (a
 *   version that was never published), making every internal package
 *   uninstallable from npm. Resolving from the live package.json files is
 *   deterministic and immune to lockfile staleness.
 *
 * The rewrite is applied in place; publish-oidc.sh snapshots and restores the
 * original file so the working tree keeps its `workspace:*` specs.
 *
 * Usage: node scripts/resolve-workspace-deps.mjs <path-to-package.json>
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const target = process.argv[2]
if (!target) {
  console.error('usage: resolve-workspace-deps.mjs <path-to-package.json>')
  process.exit(2)
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packagesDir = join(repoRoot, 'packages')

// Build a name -> version map from every workspace package's LIVE package.json.
const versions = new Map()
for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  try {
    const meta = JSON.parse(
      readFileSync(join(packagesDir, entry.name, 'package.json'), 'utf8'),
    )
    if (meta.name && meta.version) versions.set(meta.name, meta.version)
  } catch {
    // directory without a readable package.json — skip it
  }
}

const DEP_FIELDS = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
  'devDependencies',
]

const pkg = JSON.parse(readFileSync(target, 'utf8'))
let rewrites = 0

for (const field of DEP_FIELDS) {
  const deps = pkg[field]
  if (!deps || typeof deps !== 'object') continue
  for (const name of Object.keys(deps)) {
    const spec = deps[name]
    if (typeof spec !== 'string' || !spec.startsWith('workspace:')) continue

    const version = versions.get(name)
    if (!version) {
      console.error(
        `resolve-workspace-deps: FATAL — ${field}.${name} is "${spec}" but no packages/*/package.json declares "${name}"`,
      )
      process.exit(1)
    }

    // workspace:  |  workspace:*  -> exact version
    // workspace:^ -> ^version   |  workspace:~ -> ~version
    // workspace:<explicit range> -> that range verbatim (protocol stripped)
    const rest = spec.slice('workspace:'.length)
    let resolved
    if (rest === '' || rest === '*') resolved = version
    else if (rest === '^') resolved = `^${version}`
    else if (rest === '~') resolved = `~${version}`
    else resolved = rest

    deps[name] = resolved
    rewrites += 1
    console.error(
      `resolve-workspace-deps: ${field}.${name}  ${spec} -> ${resolved}`,
    )
  }
}

writeFileSync(target, `${JSON.stringify(pkg, null, 2)}\n`)
console.error(
  `resolve-workspace-deps: rewrote ${rewrites} workspace dep(s) in ${target}`,
)
