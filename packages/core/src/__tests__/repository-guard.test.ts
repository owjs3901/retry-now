import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { expect, test } from 'bun:test'

import { runGit } from '../git.ts'
import {
  guardAnalyzeRepository,
  rollbackIterationRepository,
} from '../repository-guard.ts'
import {
  captureRepositorySnapshot,
  restoreRepositorySnapshot,
} from '../repository-snapshot.ts'

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
      changed: ['src/new.ts', 'src/value.ts'],
    })
    expect(await readFile(join(root, 'src/value.ts'), 'utf8')).toBe('base\n')
    expect(await Bun.file(join(root, 'src/new.ts')).exists()).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('untracked host-agent state is omitted, ignored by ANALYZE, and preserved by restore', async () => {
  const root = await initRepo({ 'src/value.ts': 'base\n' })
  try {
    const before = await captureRepositorySnapshot(root)
    expect(before).not.toBeNull()
    if (before === null) return
    const continuation = join(root, '.omo/run-continuation/x.json')
    const sisyphus = join(root, '.sisyphus/foo')
    await mkdir(dirname(continuation), { recursive: true })
    await mkdir(dirname(sisyphus), { recursive: true })
    await writeFile(continuation, '{}\n')
    await writeFile(sisyphus, 'runtime state\n')

    const after = await captureRepositorySnapshot(root)
    expect(after?.entries.has('.omo/run-continuation/x.json')).toBe(false)
    expect(after?.entries.has('.sisyphus/foo')).toBe(false)
    expect(await guardAnalyzeRepository(root, before)).toEqual({
      kind: 'clean',
    })
    expect(await restoreRepositorySnapshot(root, before)).toBeNull()
    expect(await readFile(continuation, 'utf8')).toBe('{}\n')
    expect(await readFile(sisyphus, 'utf8')).toBe('runtime state\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('tracked .omo files remain protected and report their changed path', async () => {
  const root = await initRepo({ '.omo/plans/p.md': 'approved\n' })
  try {
    const snapshot = await captureRepositorySnapshot(root)
    expect(snapshot).not.toBeNull()
    if (snapshot === null) return
    await writeFile(join(root, '.omo/plans/p.md'), 'changed\n')

    expect(await guardAnalyzeRepository(root, snapshot)).toEqual({
      kind: 'restored',
      changed: ['.omo/plans/p.md'],
    })
    expect(await readFile(join(root, '.omo/plans/p.md'), 'utf8')).toBe(
      'approved\n',
    )
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
    const throwingRestoreRepository = {
      ...cleanRepository,
      capture: () => Promise.resolve(null),
      restore: () => Promise.reject(new Error('disk unavailable')),
    }
    const changedIndexRepository = {
      ...cleanRepository,
      capture: () =>
        Promise.resolve({ ...snapshot, indexTree: 'changed-index-tree' }),
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
    expect(
      await guardAnalyzeRepository(root, snapshot, throwingRestoreRepository),
    ).toEqual({
      kind: 'failed',
      issue: 'repository restoration threw: disk unavailable',
    })
    expect(
      await guardAnalyzeRepository(root, snapshot, changedIndexRepository),
    ).toEqual({ kind: 'restored', changed: ['Git index'] })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rollbackIterationRepository reports a thrown restore instead of throwing', async () => {
  const root = await initRepo({ 'src/value.ts': 'base\n' })
  try {
    const snapshot = await captureRepositorySnapshot(root)
    expect(snapshot).not.toBeNull()
    if (snapshot === null) return

    expect(
      await rollbackIterationRepository(root, snapshot, {
        restore: () => Promise.reject(new Error('disk unavailable')),
      }),
    ).toBe('repository restoration threw: disk unavailable')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
