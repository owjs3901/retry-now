/**
 * Coverage SOURCE gate.
 *
 * `bun test` enforces a 100% threshold, but only over the files it actually loaded — a module that no
 * test imports simply never appears in the report, so the percentage stays green while the module is
 * completely unmeasured. This gate closes that hole: EVERY TypeScript module under
 * `packages/<pkg>/src/` must appear in LCOV.
 *
 * There is exactly one way to be absent, and it is PROVEN rather than declared: a file that carries
 * no runtime code at all (pure `type` / `interface` declarations) transpiles to nothing, so there is
 * nothing to execute and no coverage entry can exist. The check transpiles each absent file and only
 * accepts it when the output is genuinely empty. A hand-maintained exemption list is deliberately
 * NOT used, because that is what previously let real modules — including the 1783-line loop driver —
 * sit outside the threshold.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const transpiler = new Bun.Transpiler({ loader: 'ts' })

/** Every `.ts` module under `dir`, recursively, excluding test files. */
async function sourceFiles(dir) {
  const found = []
  async function walk(current) {
    let entries
    try {
      entries = await readdir(join(ROOT, current), { withFileTypes: true })
    } catch {
      return // package without a src/ dir
    }
    for (const entry of entries) {
      const path = `${current}/${entry.name}`
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
      // `coverageSkipTestFiles` already drops these from the report, so they are not expected in it.
      if (entry.name.endsWith('.test.ts')) continue
      found.push(path.replaceAll('\\', '/'))
    }
  }
  await walk(dir)
  return found
}

/** True only when the module has NO runtime code, so no coverage entry can exist for it. */
async function isTypeOnly(file) {
  const source = await readFile(join(ROOT, file), 'utf8')
  try {
    return transpiler.transformSync(source).trim() === ''
  } catch {
    return false // unparseable is never an excuse
  }
}

const packages = (
  await readdir(join(ROOT, 'packages'), { withFileTypes: true })
)
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

const expected = []
for (const pkg of packages) {
  expected.push(...(await sourceFiles(`packages/${pkg}/src`)))
}

const lcov = await readFile(join(ROOT, 'coverage/lcov.info'), 'utf8')
const covered = new Set(
  [...lcov.matchAll(/^SF:(.+)$/gm)].map((match) => {
    const raw = (match[1] ?? '').trim()
    // LCOV paths may be absolute or already repo-relative depending on the runner.
    const rel = raw.includes(':') ? relative(ROOT, raw) : raw
    return rel.replaceAll('\\', '/')
  }),
)

const unmeasured = []
const typeOnly = []
for (const file of expected) {
  if (covered.has(file)) continue
  if (await isTypeOnly(file)) {
    typeOnly.push(file)
    continue
  }
  unmeasured.push(file)
}

if (unmeasured.length > 0) {
  console.error(
    `Coverage source gate FAILED — these modules carry runtime code but no test loads them, so the 100% threshold never saw them:\n${unmeasured
      .sort()
      .map((file) => `  ${file}`)
      .join('\n')}`,
  )
  process.exit(1)
}

console.log(
  `Coverage source gate passed (${expected.length - typeOnly.length} executable modules measured across ${packages.length} packages; ${typeOnly.length} type-only module(s) have no runtime code).`,
)
