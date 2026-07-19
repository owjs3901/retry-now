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

**In plugin mode** (this package loaded via the `plugin` array in `opencode.json`), `/retry-now` starts
the loop **in-process**: the command calls the `retrynow_start` tool, which launches the reincarnation
driver directly inside your running opencode instance. No external `opencode run` process is spawned.

Each phase (ANALYZE, and per item IMPLEMENT / REVIEW) becomes a **fresh child session created via the
opencode SDK**, nested under the session that invoked `/retry-now` and visible in the TUI, titled
`retry-now #NNNN ANALYZE`, `retry-now #NNNN IMPROVE item 2 implement`, and so on. A child session starts
with zero copied context, so the context-zero rebirth invariant holds exactly as it does for the CLI
path below.

Three tools drive it:

| Tool | What it does |
|---|---|
| `retrynow_start` | Starts the loop for the current project in the background and returns immediately |
| `retrynow_status` | Reports `state.json`, the active phase, and whether a `STOP` sentinel is pending |
| `retrynow_stop` | Writes the `STOP` sentinel and immediately aborts the in-flight child session |

Only phases whose resolved agent is `opencode` run this way. `codex` and `claude` roles still spawn
their own CLIs (`codex exec` / `claude -p ... --bare`), the same as outside the plugin, so a mixed-agent
config keeps working unchanged.

**Anti-hang timeout.** Each native phase races its `session.prompt` call against `phaseTimeoutMs`
(default 30 minutes, floored at 60 seconds). If a phase does not finish in time, the plugin aborts the
child session and the driver treats it as a failed attempt and retries, instead of hanging forever. This
is the fix for the failure mode native mode replaces: a stuck `opencode run` child process that hung
with no observable signal.

**Variant limitation (native mode only).** The opencode SDK's `session.prompt` call has no reasoning
effort or variant field, so a native child session cannot set `modelVariant` / `analysisVariant` /
`improveVariant` / `reviewVariant`; it runs at the model's default tier. If a specific reasoning tier
matters under native mode, set `agentProfile` to an opencode agent profile that already carries the
model and variant you want; the plugin passes it straight through as the child session's `agent`. CLI
mode (`retry-now run`, `opencode run "<msg>" --variant ...`) is not affected by this limitation.

**CLI mode** is unchanged and still available. Running `retry-now run` from a terminal, or invoking the
trigger installed by `retry-now install opencode`, spawns a brand-new, headless `opencode run "<msg>"`
process per phase, never resumed. That trigger's baked-in command runs the built `driver-entry.js`
(`bun "<path>/driver-entry.js" ...`); that spawn only happens on the CLI/trigger path described here,
not when `/retry-now` runs as a plugin.

See the **[main README](https://github.com/owjs3901/retry-now#readme)** for the loop model and
configuration, including `phaseTimeoutMs`.

## License

[MIT](https://github.com/owjs3901/retry-now/blob/main/LICENSE)
