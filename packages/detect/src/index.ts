/**
 * `@retry-now/detect` — capability detector.
 *
 * Inspects a project root for ecosystem markers (Cargo.toml / go.mod / pyproject /
 * package.json) and resolves the best test / lint / bench command per the primary
 * ecosystem. **Pure detection**: only filesystem reads. NEVER executes a command.
 *
 * Consumed by the CLI's `init` flow so it can pre-fill (and explain) sensible defaults
 * for `analysis` / `direction` / `completion` instead of asking the user from scratch.
 *
 * Priority for `primary` (and which ecosystem populates test/lint/bench):
 *     rust > go > python > node.
 * `ecosystems` lists ALL detected markers in that priority order — useful for projects
 * like a Rust workspace that also ships a package.json (then primary is still rust).
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

// ─── Public API ────────────────────────────────────────────────────────────────

export interface WorkspaceMember {
  /** crate/package name, or directory basename fallback */
  readonly name: string
  /** POSIX-style path relative to root, e.g. "crates/vespera_core" */
  readonly path: string
}

export interface DetectionResult {
  readonly ecosystems: readonly string[]
  readonly primary: string | null
  readonly test: string
  readonly lint: string
  readonly bench: string
  /** true when the primary ecosystem is a workspace with >0 members */
  readonly isMonorepo: boolean
  /** workspace members of the PRIMARY ecosystem (path-sorted); [] if not a workspace */
  readonly members: readonly WorkspaceMember[]
  readonly notes: readonly string[]
}

// ─── Internal types ────────────────────────────────────────────────────────────

type Ecosystem = 'rust' | 'go' | 'python' | 'node'

const PRIORITY: readonly Ecosystem[] = ['rust', 'go', 'python', 'node']

interface Commands {
  readonly test: string
  readonly lint: string
  readonly bench: string
  readonly notes: readonly string[]
}

interface PackageJson {
  readonly scripts?: unknown
  readonly dependencies?: unknown
  readonly devDependencies?: unknown
}

type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm'

// ─── Tiny FS helpers (never throw) ─────────────────────────────────────────────

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

async function readJsonSafe<T>(path: string): Promise<T | null> {
  const raw = await readText(path)
  if (raw === '') return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

async function listRoot(root: string): Promise<readonly string[]> {
  try {
    return await readdir(root)
  } catch {
    return []
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return {}
  return value as Record<string, unknown>
}

// ─── Ecosystem markers ─────────────────────────────────────────────────────────

async function detectRust(root: string): Promise<boolean> {
  return exists(join(root, 'Cargo.toml'))
}

async function detectGo(root: string): Promise<boolean> {
  return exists(join(root, 'go.mod'))
}

async function detectPython(root: string): Promise<boolean> {
  const markers = [
    'pyproject.toml',
    'setup.py',
    'setup.cfg',
    'requirements.txt',
  ]
  for (const m of markers) {
    if (await exists(join(root, m))) return true
  }
  return false
}

async function detectNode(root: string): Promise<boolean> {
  return exists(join(root, 'package.json'))
}

// ─── Per-ecosystem command resolvers ───────────────────────────────────────────

async function rustCommands(root: string): Promise<Commands> {
  const notes: string[] = []
  const cargoToml = await readText(join(root, 'Cargo.toml'))

  const test = 'cargo test'
  notes.push('rust: test=`cargo test` (cargo ships a built-in test runner)')

  // Rust special case: clippy ships with the toolchain. lint must NEVER be ""
  // for a Rust project — there is no config-file gate to check.
  const lint = 'cargo clippy --all-targets --all-features'
  notes.push(
    'rust: lint=`cargo clippy --all-targets --all-features` (ALWAYS for Rust — clippy ships with the toolchain; no config file required)',
  )

  let bench = ''
  const hasBenchesDir = await isDir(join(root, 'benches'))
  const hasBenchSection = cargoToml.includes('[[bench]]')
  const hasCriterion = cargoToml.includes('criterion')
  if (hasBenchesDir || hasBenchSection || hasCriterion) {
    bench = 'cargo bench'
    const reasons: string[] = []
    if (hasBenchesDir) reasons.push('`benches/` directory')
    if (hasBenchSection) reasons.push('`[[bench]]` in Cargo.toml')
    if (hasCriterion) reasons.push('`criterion` in Cargo.toml')
    notes.push(`rust: bench=\`cargo bench\` (detected: ${reasons.join(', ')})`)
  }

  return { test, lint, bench, notes }
}

async function goCommands(_root: string): Promise<Commands> {
  const notes: string[] = [
    'go: test=`go test ./...` (go ships a built-in test runner)',
    'go: lint=`go vet ./...` (go ships a built-in vet; always available)',
  ]
  return { test: 'go test ./...', lint: 'go vet ./...', bench: '', notes }
}

async function pythonCommands(root: string): Promise<Commands> {
  const notes: string[] = []
  const pyproject = await readText(join(root, 'pyproject.toml'))
  const setupCfg = await readText(join(root, 'setup.cfg'))
  const requirements = await readText(join(root, 'requirements.txt'))
  const rootEntries = await listRoot(root)

  // test: pytest is the de-facto runner; we only suggest it when there is evidence.
  let test = ''
  const hasTestsDir = await isDir(join(root, 'tests'))
  const hasTestPy = rootEntries.some(
    (n) => n.startsWith('test_') && n.endsWith('.py'),
  )
  const mentionsPytest =
    pyproject.includes('pytest') ||
    setupCfg.includes('pytest') ||
    requirements.includes('pytest')
  if (hasTestsDir || hasTestPy || mentionsPytest) {
    test = 'pytest'
    const reasons: string[] = []
    if (hasTestsDir) reasons.push('`tests/` directory')
    if (hasTestPy) reasons.push('`test_*.py` at root')
    if (mentionsPytest)
      reasons.push('`pytest` in pyproject/setup.cfg/requirements')
    notes.push(`python: test=\`pytest\` (detected: ${reasons.join(', ')})`)
  }

  // lint: ruff first (the modern default), then flake8 as a legacy fallback.
  let lint = ''
  const hasRuffToml =
    (await exists(join(root, 'ruff.toml'))) ||
    (await exists(join(root, '.ruff.toml')))
  const pyprojectHasRuff = pyproject.includes('ruff')
  const hasFlake8File = await exists(join(root, '.flake8'))
  const mentionsFlake8 =
    setupCfg.includes('flake8') || pyproject.includes('flake8')
  if (hasRuffToml || pyprojectHasRuff) {
    lint = 'ruff check .'
    const reasons: string[] = []
    if (hasRuffToml) reasons.push('`ruff.toml`/`.ruff.toml`')
    if (pyprojectHasRuff) reasons.push('`ruff` in pyproject.toml')
    notes.push(
      `python: lint=\`ruff check .\` (detected: ${reasons.join(', ')})`,
    )
  } else if (hasFlake8File || mentionsFlake8) {
    lint = 'flake8'
    const reasons: string[] = []
    if (hasFlake8File) reasons.push('`.flake8`')
    if (mentionsFlake8) reasons.push('`flake8` in setup.cfg/pyproject.toml')
    notes.push(`python: lint=\`flake8\` (detected: ${reasons.join(', ')})`)
  }

  // bench: only when pytest-benchmark is declared somewhere.
  let bench = ''
  const mentionsPytestBenchmark =
    pyproject.includes('pytest-benchmark') ||
    requirements.includes('pytest-benchmark')
  if (mentionsPytestBenchmark) {
    bench = 'pytest --benchmark-only'
    notes.push(
      'python: bench=`pytest --benchmark-only` (detected: `pytest-benchmark` in pyproject/requirements)',
    )
  }

  return { test, lint, bench, notes }
}

async function detectPackageManager(root: string): Promise<PackageManager> {
  if (
    (await exists(join(root, 'bun.lock'))) ||
    (await exists(join(root, 'bun.lockb')))
  ) {
    return 'bun'
  }
  if (await exists(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (await exists(join(root, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

/** Bun/pnpm/npm use `<pm> run <script>`. Yarn uses bare `yarn <script>`. */
function runPrefix(pm: PackageManager): string {
  switch (pm) {
    case 'bun':
      return 'bun run'
    case 'pnpm':
      return 'pnpm run'
    case 'yarn':
      return 'yarn'
    case 'npm':
      return 'npm run'
  }
}

async function nodeCommands(root: string): Promise<Commands> {
  const notes: string[] = []
  const pkg =
    (await readJsonSafe<PackageJson>(join(root, 'package.json'))) ?? {}
  const scripts = asRecord(pkg.scripts)
  const deps = {
    ...asRecord(pkg.dependencies),
    ...asRecord(pkg.devDependencies),
  }
  const pm = await detectPackageManager(root)
  const prefix = runPrefix(pm)
  notes.push(`node: package manager=\`${pm}\` (run prefix=\`${prefix}\`)`)
  const rootEntries = await listRoot(root)

  // test: explicit script wins; otherwise pick the first known framework by dep.
  let test = ''
  if (typeof scripts.test === 'string') {
    test = `${prefix} test`
    notes.push(
      `node: test=\`${test}\` (detected: \`scripts.test\` in package.json)`,
    )
  } else if ('vitest' in deps) {
    test = 'vitest run'
    notes.push('node: test=`vitest run` (detected: `vitest` dependency)')
  } else if ('jest' in deps) {
    test = 'jest'
    notes.push('node: test=`jest` (detected: `jest` dependency)')
  }

  // lint: explicit script wins; otherwise pick by file/dep in oxlint > biome > eslint
  //       priority (oxlint = fastest, biome = unified, eslint = legacy default).
  let lint = ''
  if (typeof scripts.lint === 'string') {
    lint = `${prefix} lint`
    notes.push(
      `node: lint=\`${lint}\` (detected: \`scripts.lint\` in package.json)`,
    )
  } else {
    const hasOxlintConfig = rootEntries.some((n) =>
      /^oxlint\.config\.[a-zA-Z]+$/.test(n),
    )
    const hasOxlintDep = 'oxlint' in deps
    const hasBiomeFile =
      (await exists(join(root, 'biome.json'))) ||
      (await exists(join(root, 'biome.jsonc')))
    const hasBiomeDep = '@biomejs/biome' in deps
    const hasEslintFile = rootEntries.some(
      (n) =>
        /^\.eslintrc(\.|$)/.test(n) || /^eslint\.config\.[a-zA-Z]+$/.test(n),
    )
    const hasEslintDep = 'eslint' in deps

    if (hasOxlintConfig || hasOxlintDep) {
      lint = 'oxlint'
      const reasons: string[] = []
      if (hasOxlintConfig) reasons.push('`oxlint.config.*` file')
      if (hasOxlintDep) reasons.push('`oxlint` dependency')
      notes.push(`node: lint=\`oxlint\` (detected: ${reasons.join(', ')})`)
    } else if (hasBiomeFile || hasBiomeDep) {
      lint = 'biome lint .'
      const reasons: string[] = []
      if (hasBiomeFile) reasons.push('`biome.json`/`biome.jsonc`')
      if (hasBiomeDep) reasons.push('`@biomejs/biome` dependency')
      notes.push(
        `node: lint=\`biome lint .\` (detected: ${reasons.join(', ')})`,
      )
    } else if (hasEslintFile || hasEslintDep) {
      lint = 'eslint .'
      const reasons: string[] = []
      if (hasEslintFile) reasons.push('`.eslintrc*`/`eslint.config.*` file')
      if (hasEslintDep) reasons.push('`eslint` dependency')
      notes.push(`node: lint=\`eslint .\` (detected: ${reasons.join(', ')})`)
    }
  }

  // bench: only suggest when there is an explicit script — no convention covers it.
  let bench = ''
  if (typeof scripts.bench === 'string') {
    bench = `${prefix} bench`
    notes.push(
      `node: bench=\`${bench}\` (detected: \`scripts.bench\` in package.json)`,
    )
  }

  return { test, lint, bench, notes }
}

// ─── Workspace / monorepo members ──────────────────────────────────────────────

/** Extract quoted strings inside a line-anchored `key = [ ... ]` array in TOML-ish text. */
function tomlArray(text: string, key: string): string[] {
  const re = new RegExp(
    `(?:^|\\n)[ \\t]*${key}[ \\t]*=[ \\t]*\\[([\\s\\S]*?)\\]`,
  )
  const m = re.exec(text)
  if (!m || m[1] === undefined) return []
  return [...m[1].matchAll(/"([^"]+)"/g)]
    .map((x) => x[1] ?? '')
    .filter((s) => s !== '')
}

function baseName(p: string): string {
  const parts = p.split('/').filter((s) => s !== '')
  return parts[parts.length - 1] ?? p
}

/** Expand member patterns (literal, or single-level `prefix/*`) to dirs containing `marker`. */
async function expandPatterns(
  root: string,
  patterns: readonly string[],
  marker: string,
): Promise<string[]> {
  const out: string[] = []
  for (const raw of patterns) {
    const pat = raw.replace(/\\/g, '/').replace(/\/+$/, '')
    if (pat.endsWith('/*')) {
      const prefix = pat.slice(0, -2)
      let entries: string[] = []
      try {
        entries = [...(await readdir(join(root, prefix)))].sort()
      } catch {
        entries = []
      }
      for (const e of entries) {
        const rel = prefix === '' ? e : `${prefix}/${e}`
        if (
          (await isDir(join(root, rel))) &&
          (await exists(join(root, rel, marker)))
        )
          out.push(rel)
      }
    } else if (await exists(join(root, pat, marker))) {
      out.push(pat)
    }
  }
  return out
}

async function rustMembers(root: string): Promise<WorkspaceMember[]> {
  const toml = await readText(join(root, 'Cargo.toml'))
  if (!toml.includes('[workspace]')) return []
  const patterns = tomlArray(toml, 'members')
  if (patterns.length === 0) return []
  const excluded = new Set(
    tomlArray(toml, 'exclude').map((s) => s.replace(/\/+$/, '')),
  )
  const paths = (await expandPatterns(root, patterns, 'Cargo.toml')).filter(
    (p) => !excluded.has(p),
  )
  const members: WorkspaceMember[] = []
  for (const p of paths) {
    const memberToml = await readText(join(root, p, 'Cargo.toml'))
    const nameMatch = /\[package\][\s\S]*?\bname[ \t]*=[ \t]*"([^"]+)"/.exec(
      memberToml,
    )
    members.push({ name: nameMatch?.[1] ?? baseName(p), path: p })
  }
  return members
}

async function nodeMembers(root: string): Promise<WorkspaceMember[]> {
  const pkg = await readJsonSafe<{ workspaces?: unknown }>(
    join(root, 'package.json'),
  )
  if (pkg === null) return []
  const ws = pkg.workspaces
  let patterns: string[] = []
  if (Array.isArray(ws)) {
    patterns = ws.filter((x): x is string => typeof x === 'string')
  } else if (ws !== null && typeof ws === 'object') {
    const pkgs = (ws as { packages?: unknown }).packages
    if (Array.isArray(pkgs))
      patterns = pkgs.filter((x): x is string => typeof x === 'string')
  }
  if (patterns.length === 0) return []
  const paths = await expandPatterns(root, patterns, 'package.json')
  const members: WorkspaceMember[] = []
  for (const p of paths) {
    const memberPkg = await readJsonSafe<{ name?: unknown }>(
      join(root, p, 'package.json'),
    )
    const name =
      memberPkg && typeof memberPkg.name === 'string'
        ? memberPkg.name
        : baseName(p)
    members.push({ name, path: p })
  }
  return members
}

async function detectMembers(
  root: string,
  primary: Ecosystem,
): Promise<WorkspaceMember[]> {
  const members =
    primary === 'rust'
      ? await rustMembers(root)
      : primary === 'node'
        ? await nodeMembers(root)
        : []
  return [...members].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )
}

// ─── Public detector ───────────────────────────────────────────────────────────

const DETECTORS: Readonly<
  Record<Ecosystem, (root: string) => Promise<boolean>>
> = {
  rust: detectRust,
  go: detectGo,
  python: detectPython,
  node: detectNode,
}

const RESOLVERS: Readonly<
  Record<Ecosystem, (root: string) => Promise<Commands>>
> = {
  rust: rustCommands,
  go: goCommands,
  python: pythonCommands,
  node: nodeCommands,
}

/**
 * Inspect `root` and resolve the best test/lint/bench command for its primary
 * ecosystem. Never throws — missing or unreadable files are treated as absent.
 */
export async function detectCapabilities(
  root: string,
): Promise<DetectionResult> {
  const notes: string[] = []
  const ecosystems: Ecosystem[] = []

  // Detect in priority order so `ecosystems` is already ordered correctly.
  for (const eco of PRIORITY) {
    if (await DETECTORS[eco](root)) ecosystems.push(eco)
  }

  const primary = ecosystems[0] ?? null
  if (primary === null) {
    notes.push(
      'no ecosystem markers found (Cargo.toml / go.mod / pyproject.toml / setup.py / setup.cfg / requirements.txt / package.json)',
    )
    return {
      ecosystems,
      primary,
      test: '',
      lint: '',
      bench: '',
      isMonorepo: false,
      members: [],
      notes,
    }
  }

  notes.push(
    `primary ecosystem: \`${primary}\` (detected: ${ecosystems.join(', ')}; priority order: rust > go > python > node)`,
  )

  const cmds = await RESOLVERS[primary](root)
  notes.push(...cmds.notes)

  const members = await detectMembers(root, primary)
  if (members.length > 0) {
    notes.push(
      `${primary}: workspace with ${members.length} member(s) — per-package 윤회 available`,
    )
  }

  return {
    ecosystems,
    primary,
    test: cmds.test,
    lint: cmds.lint,
    bench: cmds.bench,
    isMonorepo: members.length > 0,
    members,
    notes,
  }
}
