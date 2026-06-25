/**
 * `@retry-now/detect` — tests.
 *
 * Every test creates a temp project under the OS temp dir, drops marker files, calls
 * `detectCapabilities`, asserts the resolved commands, and cleans up. No real test/lint
 * binary is ever executed — the detector is pure file-system inspection.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import { detectCapabilities } from '../index.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'retry-now-detect-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function write(rel: string, content = ''): Promise<void> {
  await writeFile(join(dir, rel), content, 'utf8')
}

async function mkdirIn(rel: string): Promise<void> {
  await mkdir(join(dir, rel), { recursive: true })
}

// ─── empty ─────────────────────────────────────────────────────────────────────

test('empty directory: primary is null and every command is empty', async () => {
  const r = await detectCapabilities(dir)
  expect(r.primary).toBeNull()
  expect(r.ecosystems).toEqual([])
  expect(r.test).toBe('')
  expect(r.lint).toBe('')
  expect(r.bench).toBe('')
  expect(r.notes.length).toBeGreaterThan(0)
})

// ─── rust ──────────────────────────────────────────────────────────────────────

test('rust: Cargo.toml alone resolves cargo test + cargo clippy, bench empty', async () => {
  await write('Cargo.toml', '[package]\nname = "x"\n')
  const r = await detectCapabilities(dir)
  expect(r.primary).toBe('rust')
  expect(r.ecosystems).toEqual(['rust'])
  expect(r.test).toBe('cargo test')
  expect(r.lint).toBe('cargo clippy --all-targets --all-features')
  expect(r.bench).toBe('')
  // Special-case: clippy is ALWAYS chosen for rust — surface that in notes.
  expect(r.notes.some((n) => n.includes('ALWAYS'))).toBe(true)
})

test('rust: benches/ directory triggers cargo bench', async () => {
  await write('Cargo.toml', '[package]\nname = "x"\n')
  await mkdirIn('benches')
  const r = await detectCapabilities(dir)
  expect(r.primary).toBe('rust')
  expect(r.bench).toBe('cargo bench')
  expect(r.notes.some((n) => n.includes('benches/'))).toBe(true)
})

test('rust: criterion mentioned in Cargo.toml triggers cargo bench', async () => {
  await write(
    'Cargo.toml',
    '[package]\nname = "x"\n\n[dev-dependencies]\ncriterion = "0.5"\n',
  )
  const r = await detectCapabilities(dir)
  expect(r.primary).toBe('rust')
  expect(r.bench).toBe('cargo bench')
  expect(r.notes.some((n) => n.includes('criterion'))).toBe(true)
})

test('rust: [[bench]] section in Cargo.toml triggers cargo bench', async () => {
  await write(
    'Cargo.toml',
    '[package]\nname = "x"\n\n[[bench]]\nname = "foo"\nharness = false\n',
  )
  const r = await detectCapabilities(dir)
  expect(r.bench).toBe('cargo bench')
})

// ─── node ──────────────────────────────────────────────────────────────────────

test('node + bun.lock: scripts.{test,lint,bench} -> bun run <script>', async () => {
  await write(
    'package.json',
    JSON.stringify({
      name: 'n',
      scripts: {
        test: 'vitest run',
        lint: 'biome lint .',
        bench: 'vitest bench',
      },
    }),
  )
  await write('bun.lock', '{}')
  const r = await detectCapabilities(dir)
  expect(r.primary).toBe('node')
  expect(r.test).toBe('bun run test')
  expect(r.lint).toBe('bun run lint')
  expect(r.bench).toBe('bun run bench')
  expect(r.notes.some((n) => n.includes('package manager=`bun`'))).toBe(true)
})

test('node: oxlint.config.ts (no scripts) resolves lint=oxlint', async () => {
  await write('package.json', JSON.stringify({ name: 'n' }))
  await write('oxlint.config.ts', 'export default {};\n')
  const r = await detectCapabilities(dir)
  expect(r.primary).toBe('node')
  expect(r.lint).toBe('oxlint')
  expect(r.test).toBe('')
  expect(r.bench).toBe('')
})

test('node: biome.json (no scripts) resolves lint=biome lint .', async () => {
  await write('package.json', JSON.stringify({ name: 'n' }))
  await write('biome.json', '{}')
  const r = await detectCapabilities(dir)
  expect(r.primary).toBe('node')
  expect(r.lint).toBe('biome lint .')
})

// ─── python ────────────────────────────────────────────────────────────────────

test('python: pyproject.toml + tests/ -> test=pytest', async () => {
  await write('pyproject.toml', '[project]\nname = "x"\n')
  await mkdirIn('tests')
  const r = await detectCapabilities(dir)
  expect(r.primary).toBe('python')
  expect(r.ecosystems).toEqual(['python'])
  expect(r.test).toBe('pytest')
})

// ─── go ────────────────────────────────────────────────────────────────────────

test('go: go.mod -> test=go test ./..., lint=go vet ./...', async () => {
  await write('go.mod', 'module x\n\ngo 1.22\n')
  const r = await detectCapabilities(dir)
  expect(r.primary).toBe('go')
  expect(r.ecosystems).toEqual(['go'])
  expect(r.test).toBe('go test ./...')
  expect(r.lint).toBe('go vet ./...')
  expect(r.bench).toBe('')
})

// ─── priority ──────────────────────────────────────────────────────────────────

test('priority: rust + node together -> primary=rust, ecosystems=["rust","node"]', async () => {
  await write('Cargo.toml', '[package]\nname = "x"\n')
  await write(
    'package.json',
    JSON.stringify({ name: 'n', scripts: { lint: 'oxlint' } }),
  )
  await write('oxlint.config.ts', 'export default {};\n')
  const r = await detectCapabilities(dir)
  expect(r.primary).toBe('rust')
  expect(r.ecosystems).toEqual(['rust', 'node'])
  // Commands MUST come from the primary (rust), NOT the node side.
  expect(r.test).toBe('cargo test')
  expect(r.lint).toBe('cargo clippy --all-targets --all-features')
})

// ─── graceful failure ──────────────────────────────────────────────────────────

test('garbage package.json is treated as present-but-empty (no crash, no commands)', async () => {
  await write('package.json', '{ this is not json ::: ')
  const r = await detectCapabilities(dir)
  expect(r.primary).toBe('node')
  expect(r.ecosystems).toEqual(['node'])
  expect(r.test).toBe('')
  expect(r.lint).toBe('')
  expect(r.bench).toBe('')
})

// ─── workspace / monorepo members ────────────────────────────────────────────────

test('rust workspace: members from explicit path + crates/* glob, sorted by path with names', async () => {
  await write(
    'Cargo.toml',
    '[workspace]\nmembers = ["crates/*", "libs/bridge"]\nresolver = "2"\n',
  )
  await mkdirIn('crates/alpha')
  await write('crates/alpha/Cargo.toml', '[package]\nname = "alpha_crate"\n')
  await mkdirIn('crates/beta')
  await write('crates/beta/Cargo.toml', '[package]\nname = "beta_crate"\n')
  await mkdirIn('libs/bridge')
  await write('libs/bridge/Cargo.toml', '[package]\nname = "the_bridge"\n')
  await mkdirIn('crates/not-a-crate') // no Cargo.toml -> not a member
  const r = await detectCapabilities(dir)
  expect(r.primary).toBe('rust')
  expect(r.isMonorepo).toBe(true)
  expect(r.members).toEqual([
    { name: 'alpha_crate', path: 'crates/alpha' },
    { name: 'beta_crate', path: 'crates/beta' },
    { name: 'the_bridge', path: 'libs/bridge' },
  ])
})

test('node workspace: workspaces packages/* yields members with package names', async () => {
  await write(
    'package.json',
    JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
  )
  await mkdirIn('packages/one')
  await write(
    'packages/one/package.json',
    JSON.stringify({ name: '@scope/one' }),
  )
  await mkdirIn('packages/two')
  await write(
    'packages/two/package.json',
    JSON.stringify({ name: '@scope/two' }),
  )
  const r = await detectCapabilities(dir)
  expect(r.primary).toBe('node')
  expect(r.isMonorepo).toBe(true)
  expect(r.members).toEqual([
    { name: '@scope/one', path: 'packages/one' },
    { name: '@scope/two', path: 'packages/two' },
  ])
})

test('non-workspace Cargo.toml: isMonorepo false, members empty', async () => {
  await write('Cargo.toml', '[package]\nname = "solo"\n')
  const r = await detectCapabilities(dir)
  expect(r.isMonorepo).toBe(false)
  expect(r.members).toEqual([])
})

test('empty dir: isMonorepo false, members empty', async () => {
  const r = await detectCapabilities(dir)
  expect(r.isMonorepo).toBe(false)
  expect(r.members).toEqual([])
})
