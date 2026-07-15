import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { expect, test } from 'bun:test'

import type { GitResult, GitRunner } from '../git.ts'
import { runGit } from '../git.ts'
import {
  captureRepositorySnapshot,
  repositoryDelta,
  type RepositorySnapshot,
  restoreRepositoryIndex,
  restoreRepositorySnapshot,
} from '../repository-snapshot.ts'

const ROOT = 'C:/retry-now-snapshot-test'
const HEAD = 'approved-head'
const INDEX = 'approved-index'
const INDEX_FILE = Buffer.from('file')

type SnapshotFiles = NonNullable<
  Parameters<typeof captureRepositorySnapshot>[2]
>

function result(stdout = '', code = 0, stderr = ''): Promise<GitResult> {
  return Promise.resolve({ code, stdout, stderr })
}

function fakeGit(
  input: {
    readonly head?: () => string
    readonly index?: () => string
    readonly paths?: () => readonly string[]
    readonly staged?: () => readonly string[]
  } = {},
): GitRunner {
  return (args) => {
    switch (args[0]) {
      case 'rev-parse':
        return result(
          args.includes('--git-path')
            ? `${ROOT}/.git/index\n`
            : `${input.head?.() ?? HEAD}\n`,
        )
      case 'write-tree':
        return result(`${input.index?.() ?? INDEX}\n`)
      case 'ls-files': {
        if (args.includes('--stage')) {
          const staged = input.staged?.() ?? []
          return result(staged.length > 0 ? `${staged.join('\0')}\0` : '')
        }
        const paths = input.paths?.() ?? []
        return result(paths.length > 0 ? `${paths.join('\0')}\0` : '')
      }
      default:
        return result()
    }
  }
}

function codedError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(code), { code })
}

function fakeFiles(overrides: Partial<SnapshotFiles> = {}): SnapshotFiles {
  let indexFile = Buffer.from(INDEX_FILE)
  let temporaryIndex = Buffer.alloc(0)
  return {
    lstat: () =>
      Promise.resolve({
        mode: 0o644,
        isFile: () => true,
        isSymbolicLink: () => false,
      }),
    readFile: (path) =>
      Promise.resolve(
        path.endsWith('/.git/index')
          ? Buffer.from(indexFile)
          : Buffer.from('file'),
      ),
    readlink: () => Promise.resolve('target.txt'),
    rm: () => Promise.resolve(),
    mkdir: () => Promise.resolve(),
    writeFile: (path, content) => {
      if (path.includes('.retry-now-')) temporaryIndex = Buffer.from(content)
      return Promise.resolve()
    },
    rename: () => {
      indexFile = Buffer.from(temporaryIndex)
      return Promise.resolve()
    },
    chmod: () => Promise.resolve(),
    symlink: () => Promise.resolve(),
    ...overrides,
  }
}

async function initRepo(
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-snapshot-'))
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

test('capture records missing, directory, and symlink entries', async () => {
  const files = fakeFiles({
    lstat: (path) => {
      switch (basename(path)) {
        case 'missing.txt':
          return Promise.reject(codedError('ENOENT'))
        case 'folder':
          return Promise.resolve({
            mode: 0o755,
            isFile: () => false,
            isSymbolicLink: () => false,
          })
        case 'link':
          return Promise.resolve({
            mode: 0o755,
            isFile: () => false,
            isSymbolicLink: () => true,
          })
        default:
          return Promise.reject(codedError('ENOENT'))
      }
    },
  })
  const snapshot = await captureRepositorySnapshot(
    ROOT,
    fakeGit({ paths: () => ['missing.txt', 'folder', 'link'] }),
    files,
  )

  expect(snapshot?.entries.get('missing.txt')).toEqual({ kind: 'missing' })
  expect(snapshot?.entries.get('folder')).toEqual({ kind: 'directory' })
  expect(snapshot?.entries.get('link')).toEqual({
    kind: 'symlink',
    target: 'target.txt',
  })
})

test('capture rethrows non-missing filesystem errors', async () => {
  const capture = captureRepositorySnapshot(
    ROOT,
    fakeGit({ paths: () => ['blocked'] }),
    fakeFiles({ lstat: () => Promise.reject(codedError('EACCES')) }),
  )

  await expect(capture).rejects.toThrow('EACCES')
})

test('capture rejects repositories containing tracked gitlinks', async () => {
  const snapshot = await captureRepositorySnapshot(
    ROOT,
    fakeGit({ staged: () => ['160000 abcdef 0\tvendor/dependency'] }),
    fakeFiles(),
  )

  expect(snapshot).toBeNull()
})

test('real Git capture rejects a mode 160000 gitlink', async () => {
  const root = await initRepo({ 'value.txt': 'base\n' })
  try {
    const head = (await runGit(['rev-parse', 'HEAD'], root)).stdout.trim()
    const update = await runGit(
      [
        'update-index',
        '--add',
        '--cacheinfo',
        `160000,${head},vendor/dependency`,
      ],
      root,
    )
    expect(update.code).toBe(0)

    expect(await captureRepositorySnapshot(root)).toBeNull()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('restore replaces an unmerged index with the exact captured raw bytes', async () => {
  const root = await initRepo({ 'value.txt': 'base\n' })
  try {
    const baseBranch = (
      await runGit(['branch', '--show-current'], root)
    ).stdout.trim()
    await runGit(['checkout', '-b', 'conflicting-side'], root)
    await writeFile(join(root, 'value.txt'), 'side\n')
    await runGit(['add', 'value.txt'], root)
    await runGit(['commit', '-m', 'side'], root)
    await runGit(['checkout', baseBranch], root)
    await writeFile(join(root, 'value.txt'), 'main\n')
    await runGit(['add', 'value.txt'], root)
    await runGit(['commit', '-m', 'main'], root)
    const snapshot = await captureRepositorySnapshot(root)
    expect(snapshot).not.toBeNull()
    if (snapshot === null) return

    const merge = await runGit(['merge', 'conflicting-side'], root)
    expect(merge.code).not.toBe(0)
    expect((await runGit(['ls-files', '--unmerged'], root)).stdout).not.toBe('')

    expect(await restoreRepositorySnapshot(root, snapshot)).toBeNull()
    const indexPath = (
      await runGit(
        ['rev-parse', '--path-format=absolute', '--git-path', 'index'],
        root,
      )
    ).stdout.trim()
    expect((await readFile(indexPath)).equals(snapshot.indexFile)).toBe(true)
    expect(await readFile(join(root, 'value.txt'), 'utf8')).toBe('main\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('index restoration keeps the primary failure when cleanup also fails', async () => {
  const approved: RepositorySnapshot = {
    head: HEAD,
    indexTree: INDEX,
    indexFile: INDEX_FILE,
    entries: new Map(),
  }
  const issue = await restoreRepositoryIndex(
    ROOT,
    approved,
    fakeGit(),
    fakeFiles({
      writeFile: () => Promise.reject(new Error('primary write failure')),
      rm: () => Promise.reject(new Error('cleanup failure')),
    }),
  )

  expect(issue).toBe(
    'could not restore the approved Git index: primary write failure; temporary index cleanup also failed: cleanup failure',
  )
})

test('capture rejects an index that changes while files are being snapshotted', async () => {
  let reads = 0
  const snapshot = await captureRepositorySnapshot(
    ROOT,
    fakeGit(),
    fakeFiles({
      readFile: () =>
        Promise.resolve(Buffer.from(reads++ === 0 ? 'before' : 'after')),
    }),
  )

  expect(snapshot).toBeNull()
})

test('delta treats equal missing, directory, and symlink entries as unchanged', () => {
  type Entry =
    | { readonly kind: 'missing' }
    | { readonly kind: 'directory' }
    | { readonly kind: 'symlink'; readonly target: string }
  const entries = new Map<string, Entry>([
    ['missing.txt', { kind: 'missing' }],
    ['folder', { kind: 'directory' }],
    ['link', { kind: 'symlink', target: 'target.txt' }],
  ])
  const before: RepositorySnapshot = {
    head: HEAD,
    indexTree: INDEX,
    indexFile: INDEX_FILE,
    entries,
  }
  const after: RepositorySnapshot = {
    head: HEAD,
    indexTree: INDEX,
    indexFile: INDEX_FILE,
    entries: new Map(entries),
  }

  expect(repositoryDelta(before, after)).toEqual([])
})

test('restore recreates directory and symlink entries', async () => {
  type Restored =
    | { readonly kind: 'directory' }
    | { readonly kind: 'symlink'; readonly target: string }
  const restored = new Map<string, Restored>()
  let pathReads = 0
  const files = fakeFiles({
    lstat: (path) => {
      const entry = restored.get(basename(path))
      if (entry === undefined) return Promise.reject(codedError('ENOENT'))
      return Promise.resolve({
        mode: 0o755,
        isFile: () => false,
        isSymbolicLink: () => entry.kind === 'symlink',
      })
    },
    readlink: (path) => {
      const entry = restored.get(basename(path))
      return Promise.resolve(entry?.kind === 'symlink' ? entry.target : '')
    },
    mkdir: (path) => {
      if (basename(path) === 'folder')
        restored.set('folder', { kind: 'directory' })
      return Promise.resolve()
    },
    symlink: (target, path) => {
      restored.set(basename(path), { kind: 'symlink', target })
      return Promise.resolve()
    },
  })
  const approved: RepositorySnapshot = {
    head: HEAD,
    indexTree: INDEX,
    indexFile: INDEX_FILE,
    entries: new Map([
      ['folder', { kind: 'directory' as const }],
      ['link', { kind: 'symlink' as const, target: 'target.txt' }],
    ]),
  }
  const git = fakeGit({
    paths: () => (pathReads++ === 0 ? [] : ['folder', 'link']),
  })

  expect(await restoreRepositorySnapshot(ROOT, approved, git, files)).toBeNull()
  expect(restored.get('folder')).toEqual({ kind: 'directory' })
  expect(restored.get('link')).toEqual({
    kind: 'symlink',
    target: 'target.txt',
  })
})

test('index and snapshot restoration reject a changed HEAD', async () => {
  const approved: RepositorySnapshot = {
    head: HEAD,
    indexTree: INDEX,
    indexFile: INDEX_FILE,
    entries: new Map(),
  }
  const git = fakeGit({ head: () => 'changed-head' })

  expect(await restoreRepositoryIndex(ROOT, approved, git)).toBe(
    'Git HEAD changed; refusing index restoration',
  )
  expect(
    await restoreRepositorySnapshot(ROOT, approved, git, fakeFiles()),
  ).toBe(`Git HEAD changed from ${HEAD} to changed-head`)
})

test('index restoration reports both replacement and temporary cleanup failures', async () => {
  const approved: RepositorySnapshot = {
    head: HEAD,
    indexTree: INDEX,
    indexFile: INDEX_FILE,
    entries: new Map(),
  }
  const files = fakeFiles({
    writeFile: () => Promise.reject(new Error('replacement denied')),
    rm: () => Promise.reject(new Error('cleanup denied')),
  })

  expect(await restoreRepositoryIndex(ROOT, approved, fakeGit(), files)).toBe(
    'could not restore the approved Git index: replacement denied; temporary index cleanup also failed: cleanup denied',
  )
})

test('restore reports filesystem failures', async () => {
  const approved: RepositorySnapshot = {
    head: HEAD,
    indexTree: INDEX,
    indexFile: INDEX_FILE,
    entries: new Map([
      [
        'value.ts',
        {
          kind: 'file' as const,
          content: Buffer.from('approved'),
          mode: 0o644,
        },
      ],
    ]),
  }
  const files = fakeFiles({
    lstat: () => Promise.reject(codedError('ENOENT')),
    rm: () => Promise.reject(new Error('locked file')),
  })

  expect(
    await restoreRepositorySnapshot(ROOT, approved, fakeGit(), files),
  ).toBe('could not restore approved file content: locked file')
})

test('restore converts a non-Error index restoration failure into a message instead of throwing', async () => {
  const approved: RepositorySnapshot = {
    head: HEAD,
    indexTree: INDEX,
    indexFile: INDEX_FILE,
    entries: new Map(),
  }
  const files = fakeFiles({
    writeFile: () => Promise.reject('not an Error instance'),
  })

  expect(
    await restoreRepositorySnapshot(ROOT, approved, fakeGit(), files),
  ).toBe('could not restore the approved Git index: not an Error instance')
})

test('restore rejects a mismatched verification snapshot', async () => {
  let indexReads = 0
  const approved: RepositorySnapshot = {
    head: HEAD,
    indexTree: INDEX,
    indexFile: INDEX_FILE,
    entries: new Map(),
  }
  const git = fakeGit({
    index: () => (indexReads++ === 0 ? INDEX : 'changed-index'),
  })

  expect(
    await restoreRepositorySnapshot(
      ROOT,
      approved,
      git,
      fakeFiles({
        readFile: () => Promise.resolve(Buffer.from('changed-index-file')),
      }),
    ),
  ).toBe('repository did not match the approved snapshot after restoration')
})
