# @retry-now/codex

**[Codex CLI](https://developers.openai.com/codex)** integration for **[retry-now](https://github.com/owjs3901/retry-now)** —
an autonomous self-improvement loop (윤회 / *reincarnation*) whose context is **reborn at 0 every
iteration**.

This package installs a **`$retry-now`** skill into Codex that launches the reincarnation loop for the
current project.

## Install the skill

```bash
bunx @retry-now/codex               # install into the current project
bunx @retry-now/codex --personal    # install into your home (global) instead
```

| Flag | Effect |
|---|---|
| `--cwd <path>` | Target project root (default: current directory) |
| `--personal` | Install to your home skills directory instead of the project |

The skill is written to `.agents/skills/retry-now/SKILL.md`. You can also install it via the main CLI:

```bash
retry-now install codex
```

## Use it

Inside Codex, run:

```
$retry-now
```

When no config exists it runs the setup interview (analysis / direction / completion) first, then
starts the loop.

## How it runs

Each life is a one-shot, headless, **brand-new** session spawned as `codex exec "<msg>"` — no
`--continue`, no `--resume`. The agent judges the code as it is right now, with no memory of previous
lives, which is exactly what retry-now's unbiased-analysis guarantee requires.

See the **[main README](https://github.com/owjs3901/retry-now#readme)** for the loop model and
configuration.

## License

[MIT](https://github.com/owjs3901/retry-now/blob/main/LICENSE)
