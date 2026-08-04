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

Four tools drive it:

| Tool | What it does |
|---|---|
| `retrynow_start` | Starts the loop for the current project in the background and returns immediately |
| `retrynow_status` | Reports `state.json`, the active phase, and whether a `STOP` sentinel is pending |
| `retrynow_stop` | Writes the `STOP` sentinel and immediately aborts the in-flight child session |
| `retrynow_recover` | Recovers a batch whose driver was killed: commits the items that already passed independent review, rolls the unreviewed item back from its backup |

### Surviving a restart

Because the driver runs **inside** your opencode process, restarting opencode kills it — and over a run
that lasts hours or days that is an ordinary event, not an exception. A killed driver cannot finish its
batch, so items that already passed independent review can be left **uncommitted** in the working tree.

`retrynow_status` detects this (state says the loop is progressing, but no loop is active in this
process) and tells you which way to go:

- An interrupted batch is still recorded → run **`retrynow_recover` first**. Restarting first is the
  destructive path: a new life absorbs those changes into its baseline, and their provenance, evidence,
  and review verdicts are gone permanently with no trace in history.
- Nothing left in flight → just `retrynow_start` to resume.

Recovery fails closed. Anything it cannot prove — a missing per-item backup, review signals that are not
a contiguous prefix, a commit that appeared mid-batch, a red test/lint run afterwards, or a changed file
it cannot attribute — is refused with the reason, leaving the repository untouched for you to inspect.

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
