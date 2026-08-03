# @retry-now/core

The engine behind **[retry-now](https://github.com/owjs3901/retry-now)** — an autonomous
self-improvement loop (윤회 / *reincarnation*) whose context is **reborn at 0 every iteration**.

This package is the shared runtime that the CLI and every agent integration build on. It owns the
scaffold, the agent ↔ driver protocol, prompt synthesis, the agent adapters, and the reincarnation
loop driver itself.

> Most users don't install this directly — reach for **[`@retry-now/cli`](https://www.npmjs.com/package/@retry-now/cli)**
> or one of the agent integrations. Install `@retry-now/core` only when building your own tooling on
> top of the engine.

## Install

```bash
bun add @retry-now/core   # or: npm install @retry-now/core
```

## What's inside

| Area | Responsibility |
|---|---|
| **scaffold** | Creates and maintains the git-ignored `.retry-now/` runtime directory |
| **signal / state protocol** | The one-way agent → driver `signal.json` and the driver-owned `state.json` convergence counters |
| **prompt synthesis** | Builds each life's `analyze` / `improve` prompts from the three intent prompts in the config |
| **agent adapters** | Spawns a fresh, headless, zero-context session for `opencode` \| `codex` \| `claude` |
| **loop driver** | Runs one life end-to-end (analyze → improve → record) and decides when the loop has *consummated (converged)* |
| **frontends** | Installs the `/retry-now` (or `$retry-now`) trigger for each agent |

## Public API

```ts
import {
  runDriverCli,          // entrypoint used by the CLI / agent driver-entry scripts
  installFrontend,       // install the /retry-now trigger for an agent
  buildFrontendBody,     // synthesize the trigger command body
  recoverProject,        // reconstruct a loop whose driver was killed mid-batch
  createCommandRunner,   // wrap a spawn into the test/lint runner `recoverProject` requires
  spawnVerifyCommand,    // the default shell spawn for configured verification commands
  type RecoverReport,
  type FrontendInstallResult,
} from '@retry-now/core'
```

`recoverProject` requires a `commandRunner` rather than defaulting one, so the module never creates a
child process itself:

```ts
const { reports, code } = await recoverProject(projectRoot, {
  commandRunner: createCommandRunner(spawnVerifyCommand),
})
```

The engine is dependency-light and runs on **[Bun](https://bun.sh)** ≥ 1.1.

## How one life runs

Each iteration starts with a brand-new ANALYZE session. It reads the code, produces a batch plan of
independently revertible items, then the driver runs a fresh implementation session and a separate
fresh review session for each item. A review's kept verdict is a recommendation: the driver independently
re-runs configured test/lint before advancing the approved snapshot and reverts only that item on failure.
Only driver-gated outcomes are recorded. Analysis, implementation, and review may each select a different
CLI agent, model, and variant. The loop
stops only when several consecutive lives honestly find nothing left to improve.

Repository transactions cover **Git-visible files only**: tracked files, non-ignored untracked files,
symlinks, and modes. The approved index is restored from its exact captured bytes, then verified by HEAD,
the staged tree, and file contents, modes, and symlinks; post-restoration raw index bytes may differ because
Git regenerates its stat cache. Git-ignored files are outside the restore boundary. ANALYZE mutations are
restored by the driver, ordinary mid-batch aborts restore the full iteration start, and an agent-created commit
is left untouched while a project-level HEAD quarantine blocks reruns. Repositories containing submodule/gitlink
entries are rejected before an agent is launched.

Those guarantees assume the driver is alive to enforce them, which a host restart breaks. A `driver.lock`
still present at startup proves the previous driver was killed, so the next run transitions that run's stale
`status: running` to `interrupted` and reports any uncommitted residue. `recoverProject` then reconstructs the
batch from the per-item review signals and backups: it rolls the first unreviewed item back, re-runs the
configured test/lint, proves commit attribution, and commits only the reviewed-kept prefix — refusing, with a
reason, at any step it cannot prove.

See the **[main README](https://github.com/owjs3901/retry-now#readme)** for the full model, the
convergence rules, and configuration.

## License

[MIT](https://github.com/owjs3901/retry-now/blob/main/LICENSE)
