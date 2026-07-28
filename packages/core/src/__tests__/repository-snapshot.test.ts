import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { expect, test } from 'bun:test'

import { type GitResult, type GitRunner, runGit } from '../git.ts'
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

test('restore preserves pre-existing untracked host-agent state that becomes staged', async () => {
  const root = await initRepo({ 'src/value.ts': 'base\n' })
  try {
    const statePath = join(root, '.omo/keep.json')
    await mkdir(dirname(statePath), { recursive: true })
    await writeFile(statePath, '{"keep":true}\n')
    const snapshot = await captureRepositorySnapshot(root)
    expect(snapshot).not.toBeNull()
    if (snapshot === null) return
    expect(snapshot.entries.has('.omo/keep.json')).toBe(false)
    expect((await runGit(['add', '.omo/keep.json'], root)).code).toBe(0)

    expect(await restoreRepositorySnapshot(root, snapshot)).toBeNull()
    const indexPath = (
      await runGit(
        ['rev-parse', '--path-format=absolute', '--git-path', 'index'],
        root,
      )
    ).stdout.trim()
    expect((await readFile(indexPath)).equals(snapshot.indexFile)).toBe(true)
    expect(await readFile(statePath, 'utf8')).toBe('{"keep":true}\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('restore keeps tracked host-agent state inside the transaction boundary', async () => {
  const root = await initRepo({ '.omo/plans/p.md': 'approved\n' })
  try {
    const statePath = join(root, '.omo/plans/p.md')
    const snapshot = await captureRepositorySnapshot(root)
    expect(snapshot).not.toBeNull()
    if (snapshot === null) return
    await writeFile(statePath, 'changed\n')

    expect(await restoreRepositorySnapshot(root, snapshot)).toBeNull()
    expect(await readFile(statePath)).toEqual(Buffer.from('approved\n'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('restore deletes ordinary untracked files absent from the snapshot', async () => {
  const root = await initRepo({ 'src/value.ts': 'base\n' })
  try {
    const snapshot = await captureRepositorySnapshot(root)
    expect(snapshot).not.toBeNull()
    if (snapshot === null) return
    const untrackedPath = join(root, 'src/evil.ts')
    await writeFile(untrackedPath, 'unapproved\n')

    expect(await restoreRepositorySnapshot(root, snapshot)).toBeNull()
    expect(await Bun.file(untrackedPath).exists()).toBe(false)
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
  let indexReads = 0
  const snapshot = await captureRepositorySnapshot(
    ROOT,
    fakeGit({
      index: () => (indexReads++ === 0 ? INDEX : 'changed-index'),
    }),
    fakeFiles(),
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
  ).toBe(
    `repository did not match the approved snapshot after restoration: staged tree is changed-index, expected ${INDEX}`,
  )
})

test('restore accepts stat-cache index churn after rewriting multiple files', async () => {
  const root = await initRepo({
    'src/first.ts': 'first approved\n',
    'src/second.ts': 'second approved\n',
    'src/third.ts': 'third approved\n',
  })
  try {
    const trackedPaths = ['src/first.ts', 'src/second.ts', 'src/third.ts']
    const oldTimestamp = new Date('2000-01-01T00:00:00.000Z')
    for (const path of trackedPaths) {
      await utimes(join(root, path), oldTimestamp, oldTimestamp)
    }
    expect((await runGit(['update-index', '--refresh'], root)).code).toBe(0)
    const snapshot = await captureRepositorySnapshot(root)
    expect(snapshot).not.toBeNull()
    if (snapshot === null) return

    await writeFile(join(root, 'src/first.ts'), 'first changed\n')
    await writeFile(join(root, 'src/second.ts'), 'second changed\n')
    await writeFile(join(root, 'src/third.ts'), 'third changed\n')
    await writeFile(join(root, 'src/untracked.ts'), 'remove me\n')
    let writeTreeCalls = 0
    const refreshingGit: GitRunner = async (args, cwd) => {
      if (args[0] === 'write-tree' && writeTreeCalls++ === 2) {
        await runGit(['status', '--porcelain'], cwd)
      }
      return runGit(args, cwd)
    }

    const issue = await restoreRepositorySnapshot(root, snapshot, refreshingGit)
    const status = await runGit(['status', '--porcelain'], root)
    const restored = await captureRepositorySnapshot(root)
    expect(restored).not.toBeNull()
    if (restored === null) return
    if (restored.indexFile.equals(snapshot.indexFile)) {
      const alternateTimestamp = new Date('2001-01-01T00:00:00.000Z')
      for (const path of trackedPaths) {
        await utimes(join(root, path), alternateTimestamp, alternateTimestamp)
      }
      expect((await runGit(['update-index', '--refresh'], root)).code).toBe(0)
    }
    const observed = await captureRepositorySnapshot(root)
    expect(observed).not.toBeNull()
    if (observed === null) return

    expect(issue).toBeNull()
    expect(status.stdout).toBe('')
    expect(observed.indexFile.equals(snapshot.indexFile)).toBe(false)
    expect(observed.head).toBe(snapshot.head)
    expect(observed.indexTree).toBe(snapshot.indexTree)
    expect(repositoryDelta(snapshot, observed)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)

test('restore reports a staged tree changed during verification', async () => {
  const root = await initRepo({ 'value.txt': 'approved\n' })
  try {
    const snapshot = await captureRepositorySnapshot(root)
    expect(snapshot).not.toBeNull()
    if (snapshot === null) return
    const stagedPath = join(root, 'staged.txt')
    await writeFile(stagedPath, 'staged before restoration\n')
    await runGit(['add', 'staged.txt'], root)
    const changed = await captureRepositorySnapshot(root)
    expect(changed?.indexTree).not.toBe(snapshot.indexTree)

    let headReads = 0
    const restagingGit: GitRunner = async (args, cwd) => {
      if (
        args[0] === 'rev-parse' &&
        !args.includes('--git-path') &&
        headReads++ === 2
      ) {
        await writeFile(stagedPath, 'staged during verification\n')
        await runGit(['add', 'staged.txt'], cwd)
      }
      return runGit(args, cwd)
    }

    const issue = await restoreRepositorySnapshot(root, snapshot, restagingGit)
    const actualTree = (await runGit(['write-tree'], root)).stdout.trim()
    expect(issue).toBe(
      `repository did not match the approved snapshot after restoration: staged tree is ${actualTree}, expected ${snapshot.indexTree}`,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)

test('restore reports a HEAD changed during verification', async () => {
  const approved: RepositorySnapshot = {
    head: HEAD,
    indexTree: INDEX,
    indexFile: INDEX_FILE,
    entries: new Map(),
  }
  let headReads = 0
  const git = fakeGit({
    head: () => (headReads++ < 2 ? HEAD : 'changed-head'),
  })

  expect(
    await restoreRepositorySnapshot(ROOT, approved, git, fakeFiles()),
  ).toBe(
    `repository did not match the approved snapshot after restoration: HEAD is changed-head, expected ${HEAD}`,
  )
})

test('restore reports three differing files after verification', async () => {
  const approved: RepositorySnapshot = {
    head: HEAD,
    indexTree: INDEX,
    indexFile: INDEX_FILE,
    entries: new Map(),
  }
  let pathReads = 0
  const git = fakeGit({
    paths: () => (pathReads++ < 2 ? [] : ['src/a.ts', 'src/b.ts', 'src/c.ts']),
  })

  expect(
    await restoreRepositorySnapshot(ROOT, approved, git, fakeFiles()),
  ).toBe(
    'repository did not match the approved snapshot after restoration: 3 file(s) differ (src/a.ts, src/b.ts, src/c.ts)',
  )
})

test('restore caps the differing file list after verification', async () => {
  const approved: RepositorySnapshot = {
    head: HEAD,
    indexTree: INDEX,
    indexFile: INDEX_FILE,
    entries: new Map(),
  }
  const paths = [
    'src/a.ts',
    'src/b.ts',
    'src/c.ts',
    'src/d.ts',
    'src/e.ts',
    'src/f.ts',
    'src/g.ts',
  ]
  let pathReads = 0
  const git = fakeGit({
    paths: () => (pathReads++ < 2 ? [] : paths),
  })

  expect(
    await restoreRepositorySnapshot(ROOT, approved, git, fakeFiles()),
  ).toBe(
    'repository did not match the approved snapshot after restoration: 7 file(s) differ (src/a.ts, src/b.ts, src/c.ts, src/d.ts, src/e.ts) (+2 more)',
  )
})

test('capture rejects a HEAD that changes while files are being snapshotted', async () => {
  let headReads = 0
  const snapshot = await captureRepositorySnapshot(
    ROOT,
    fakeGit({
      head: () => (headReads++ === 0 ? HEAD : 'changed-head'),
    }),
    fakeFiles(),
  )

  expect(snapshot).toBeNull()
})

test('capture reads the raw index once, between entry capture and the closing tree check', async () => {
  // The retained bytes must be the ones the closing `write-tree` check vouches for, and the read
  // must not be duplicated: an extra discarded read is pure I/O that proves nothing.
  const order: string[] = []
  const snapshot = await captureRepositorySnapshot(
    ROOT,
    fakeGit({
      index: () => {
        order.push('write-tree')
        return INDEX
      },
    }),
    fakeFiles({
      readFile: () => {
        order.push('read-index')
        return Promise.resolve(Buffer.from('approved-index-bytes'))
      },
    }),
  )

  expect(snapshot?.indexTree).toBe(INDEX)
  expect(snapshot?.indexFile).toEqual(Buffer.from('approved-index-bytes'))
  expect(order.filter((step) => step === 'read-index')).toHaveLength(1)
  expect(order.at(-1)).toBe('write-tree')
})

test('capture tolerates raw index bytes that change while entries are snapshotted', async () => {
  // Stat-cache churn alone must not fail capture; only a staged-tree or HEAD move may.
  let reads = 0
  const snapshot = await captureRepositorySnapshot(
    ROOT,
    fakeGit(),
    fakeFiles({
      readFile: () => {
        reads += 1
        return Promise.resolve(Buffer.from(`index-revision-${reads}`))
      },
    }),
  )

  expect(snapshot).not.toBeNull()
  expect(snapshot?.indexTree).toBe(INDEX)
})
