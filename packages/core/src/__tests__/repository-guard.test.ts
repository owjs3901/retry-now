import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { expect, test } from 'bun:test'

import { runGit } from '../git.ts'
import {
  guardAnalyzeRepository,
  rollbackIterationRepository,
} from '../repository-guard.ts'
import { captureRepositorySnapshot } from '../repository-snapshot.ts'

async function initRepo(
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-transaction-'))
  await runGit(['init'], root)
  await runGit(['config', 'user.email', 'test@retry-now.local'], root)
  await runGit(['config', 'user.name', 'retry-now test'], root)
  await runGit(['config', 'commit.gpgsign', 'false'], root)
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, content)
  }
  await runGit(['add', '.'], root)
  await runGit(['commit', '-m', 'fixture'], root)
  return root
}

test('ANALYZE mutation is restored to its Git-visible starting snapshot', async () => {
  const root = await initRepo({ 'src/value.ts': 'base\n' })
  try {
    const snapshot = await captureRepositorySnapshot(root)
    expect(snapshot).not.toBeNull()
    if (snapshot === null) return
    await writeFile(join(root, 'src/value.ts'), 'analyze mutation\n')
    await writeFile(join(root, 'src/new.ts'), 'created by analyze\n')

    expect(await guardAnalyzeRepository(root, snapshot)).toEqual({
      kind: 'restored',
    })
    expect(await readFile(join(root, 'src/value.ts'), 'utf8')).toBe('base\n')
    expect(await Bun.file(join(root, 'src/new.ts')).exists()).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ordinary later-item abort restores the whole iteration start', async () => {
  const root = await initRepo({ 'src/value.ts': 'base\n' })
  try {
    const snapshot = await captureRepositorySnapshot(root)
    expect(snapshot).not.toBeNull()
    if (snapshot === null) return
    await writeFile(join(root, 'src/value.ts'), 'kept item one\n')
    await writeFile(join(root, 'src/later.ts'), 'partial item two\n')

    expect(await rollbackIterationRepository(root, snapshot)).toBeNull()
    expect(await readFile(join(root, 'src/value.ts'), 'utf8')).toBe('base\n')
    expect(await Bun.file(join(root, 'src/later.ts')).exists()).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ANALYZE commit is reported distinctly and remains untouched', async () => {
  const root = await initRepo({ 'src/value.ts': 'base\n' })
  try {
    const snapshot = await captureRepositorySnapshot(root)
    expect(snapshot).not.toBeNull()
    if (snapshot === null) return
    await writeFile(join(root, 'src/value.ts'), 'rogue commit\n')
    await runGit(['add', 'src/value.ts'], root)
    await runGit(['commit', '-m', 'unauthorized analyze commit'], root)
    const actualHead = (await runGit(['rev-parse', 'HEAD'], root)).stdout.trim()

    expect(await guardAnalyzeRepository(root, snapshot)).toEqual({
      kind: 'head-changed',
      expectedHead: snapshot.head,
      actualHead,
    })
    expect((await runGit(['rev-parse', 'HEAD'], root)).stdout.trim()).toBe(
      actualHead,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ANALYZE guard distinguishes clean, unavailable, and failed restore states', async () => {
  const root = await initRepo({ 'src/value.ts': 'base\n' })
  try {
    const snapshot = await captureRepositorySnapshot(root)
    expect(snapshot).not.toBeNull()
    if (snapshot === null) return
    const cleanRepository = {
      capture: () => Promise.resolve(snapshot),
      head: () => Promise.resolve(snapshot.head),
      restore: () => Promise.resolve(null),
    }
    const unavailableRepository = {
      ...cleanRepository,
      head: () => Promise.resolve(null),
    }
    const failedRestoreRepository = {
      ...cleanRepository,
      capture: () => Promise.resolve(null),
      restore: () => Promise.resolve('locked repository'),
    }

    expect(
      await guardAnalyzeRepository(root, snapshot, cleanRepository),
    ).toEqual({ kind: 'clean' })
    expect(
      await guardAnalyzeRepository(root, snapshot, unavailableRepository),
    ).toEqual({
      kind: 'failed',
      issue: 'Git HEAD is unavailable after ANALYZE',
    })
    expect(
      await guardAnalyzeRepository(root, snapshot, failedRestoreRepository),
    ).toEqual({ kind: 'failed', issue: 'locked repository' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
