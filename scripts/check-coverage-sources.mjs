import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = process.cwd()
const EXCLUDED_CORE = new Set([
  'loop-driver.ts', // subprocess/process orchestration; exercised through integration/manual QA
  'frontends.ts', // agent-home/project installer boundary
  'index.ts', // public re-export barrel
  'scaffold.ts', // runtime filesystem scaffolding boundary
  'types.ts', // type-only contracts
])

async function sourceFiles(dir, excluded = new Set()) {
  const entries = await readdir(join(ROOT, dir), { withFileTypes: true })
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !excluded.has(entry.name),
    )
    .map((entry) => `${dir}/${entry.name}`.replaceAll('\\', '/'))
}

const expected = new Set([
  ...(await sourceFiles('packages/core/src', EXCLUDED_CORE)),
  ...(await sourceFiles('packages/detect/src')),
])
const lcov = await readFile(join(ROOT, 'coverage/lcov.info'), 'utf8')
const covered = new Set(
  [...lcov.matchAll(/^SF:(.+)$/gm)].map((match) =>
    (match[1] ?? '').trim().replaceAll('\\', '/'),
  ),
)
const missing = [...expected].filter((file) => !covered.has(file)).sort()

if (missing.length > 0) {
  console.error(
    `Coverage source gate failed; LCOV omitted:\n${missing.join('\n')}`,
  )
  process.exit(1)
}

console.log(
  `Coverage source gate passed (${expected.size} production modules).`,
)
