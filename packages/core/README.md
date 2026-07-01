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
  type FrontendInstallResult,
} from '@retry-now/core'
```

The engine is dependency-light and runs on **[Bun](https://bun.sh)** ≥ 1.1.

## How one life runs

Each iteration is a brand-new agent session with no memory of previous lives. It **ANALYZE**s the
code read-only, produces a batch plan of independently revertible items, **IMPROVE**s them one by one
(backing up and reverting per item on any regression), and the driver records the result. The loop
stops only when several consecutive lives honestly find nothing left to improve.

See the **[main README](https://github.com/owjs3901/retry-now#readme)** for the full model, the
convergence rules, and configuration.

## License

[MIT](https://github.com/owjs3901/retry-now/blob/main/LICENSE)
