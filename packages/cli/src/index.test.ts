import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolvePaths, slugifyTarget } from '@retry-now/core'
import { expect, test } from 'bun:test'

const TARGETS = ['packages/a', 'packages/b'] as const

test('reset restarts every configured package loop before clearing quarantine', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-now-cli-reset-'))
  const paths = resolvePaths(root)
  try {
    await mkdir(paths.dir, { recursive: true })
    await writeFile(
      paths.config,
      `${JSON.stringify({
        version: 1,
        agent: 'opencode',
        analysis: 'analyze',
        direction: 'improve safely',
        completion: 'verified',
        threshold: 4,
        revertThreshold: 2,
        targets: TARGETS,
      })}\n`,
    )
    for (const target of TARGETS) {
      const targetPaths = resolvePaths(root, slugifyTarget(target))
      await mkdir(join(targetPaths.dir, 'targets', slugifyTarget(target)), {
        recursive: true,
      })
      await writeFile(
        targetPaths.state,
        '{"status":"stopped-converged","iteration":9}\n',
      )
    }
    await writeFile(paths.stop, '')
    await writeFile(paths.headQuarantine, '{}\n')

    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, 'index.ts'),
        'reset',
        '--cwd',
        root,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const code = await child.exited

    expect(code).toBe(0)
    for (const target of TARGETS) {
      const state = await readFile(
        resolvePaths(root, slugifyTarget(target)).state,
        'utf8',
      )
      expect(state).toContain('"status": "running"')
      expect(state).toContain('"iteration": 0')
      expect(state).toContain('"threshold": 4')
      expect(state).toContain('"revertThreshold": 2')
    }
    expect(await Bun.file(paths.stop).exists()).toBe(false)
    expect(await Bun.file(paths.headQuarantine).exists()).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
