# @retry-now/opencode

**[opencode](https://opencode.ai)** plugin for **[retry-now](https://github.com/owjs3901/retry-now)** —
an autonomous self-improvement loop (윤회 / *reincarnation*) whose context is **reborn at 0 every
iteration**.

This plugin registers a **`/retry-now`** command that launches the reincarnation loop driver for the
current project. **No global CLI install is needed** — the driver path and project root are baked in
at load time.

## Install (recommended — as a plugin)

Add it to the `plugin` array in `opencode.json`; opencode **auto-installs** it with Bun at startup and
registers the command:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@retry-now/opencode"]
}
```

To develop against a local copy instead, drop the plugin in `.opencode/plugins/`.

## Use it

Inside opencode, run:

```
/retry-now
```

When no config exists it runs the setup interview (analysis / direction / completion) first, then
starts the loop.

## How it runs

Each life is a one-shot, headless, **brand-new** `opencode run "<msg>"` session — never resumed, so
every iteration analyses the code with a fresh, zero-context pair of eyes. That unbiased rebirth is
the core of retry-now's convergence guarantee.

See the **[main README](https://github.com/owjs3901/retry-now#readme)** for the loop model and
configuration.

## License

[MIT](https://github.com/owjs3901/retry-now/blob/main/LICENSE)
