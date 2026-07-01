# @retry-now/cli

The `retry-now` command — the terminal entry point to **[retry-now](https://github.com/owjs3901/retry-now)**,
an autonomous self-improvement loop (윤회 / *reincarnation*) that keeps reincarnating your codebase
until the improvement is **consummated (converged)**.

Works with **[opencode](https://opencode.ai) · [Codex CLI](https://developers.openai.com/codex) · [Claude Code](https://code.claude.com)**.

## Prerequisites

- **[Bun](https://bun.sh)** ≥ 1.1
- At least one agent CLI on `PATH`: `opencode`, `codex`, or `claude`
- `git` (the loop runs inside your repo; per-iteration commits are on by default)

## Install

Run without installing:

```bash
bunx @retry-now/cli init     # interactive setup
bunx @retry-now/cli run      # run until convergence
```

Or install globally:

```bash
bun add -g @retry-now/cli    # or: npm install -g @retry-now/cli
retry-now init
```

## Commands

| Command | What it does |
|---|---|
| `retry-now init` | Interactive setup; writes `.retry-now/config.json` + scaffolds the runtime directory |
| `retry-now run` | Run the loop to a terminal state |
| `retry-now install <agent>` | Install the `/retry-now` (or `$retry-now`) trigger for `opencode` \| `claude` \| `codex` |
| `retry-now status` | Show the current loop state (iteration, streak, mode) |
| `retry-now reset` | Reset the loop counters, keeping the config |
| `retry-now version` | Print the version (`-v` / `--version`) |

## Options

| Flag | Effect |
|---|---|
| `--cwd <path>` | Target project root (default: current directory) |
| `--personal` | `install` to your home (global) instead of the project |
| `--dry-run` | Simulate the control flow without spawning an agent |
| `--commit` / `--no-commit` | Override `commitPerIteration` for this run only |

## Quick start

```bash
retry-now init   # detects your stack, asks for the three intent prompts + thresholds
retry-now run    # reincarnate until consummated
```

`init` auto-detects your stack (via [`@retry-now/detect`](https://www.npmjs.com/package/@retry-now/detect))
to pre-fill sensible test / lint / benchmark commands. Everything is written to `.retry-now/config.json`.

See the **[main README](https://github.com/owjs3901/retry-now#readme)** for the loop model, the three
intent prompts, and the full configuration reference.

## License

[MIT](https://github.com/owjs3901/retry-now/blob/main/LICENSE)
