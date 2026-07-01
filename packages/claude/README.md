# @retry-now/claude

**[Claude Code](https://code.claude.com)** integration for **[retry-now](https://github.com/owjs3901/retry-now)** —
an autonomous self-improvement loop (윤회 / *reincarnation*) whose context is **reborn at 0 every
iteration**.

This package installs a **`/retry-now`** slash command into Claude Code that launches the
reincarnation loop for the current project.

## Install the command

```bash
bunx @retry-now/claude               # install into the current project
bunx @retry-now/claude --personal    # install into your home (global) instead
```

| Flag | Effect |
|---|---|
| `--cwd <path>` | Target project root (default: current directory) |
| `--personal` | Install to `~/.claude/commands/` instead of the project |

The command is written to `.claude/commands/retry-now.md`. You can also install it via the main CLI:

```bash
retry-now install claude
```

## Use it

Inside Claude Code, run:

```
/retry-now
```

When no config exists it runs the setup interview (analysis / direction / completion) first, then
starts the loop.

## How it runs

Each life is a one-shot, headless, **brand-new** session spawned as `claude -p "<msg>" --bare`.
`--bare` skips `CLAUDE.md` / hooks / skills / MCP autoload, giving a deterministic clean rebirth — a
perfect fit for retry-now's unbiased-analysis guarantee.

See the **[main README](https://github.com/owjs3901/retry-now#readme)** for the loop model and
configuration.

## License

[MIT](https://github.com/owjs3901/retry-now/blob/main/LICENSE)
