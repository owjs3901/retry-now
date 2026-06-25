# @retry-now/detect

Dependency-free capability detector. Inspects a project root and reports which
**test / lint / benchmark** commands are runnable. Consumed by the CLI's `init`
flow so it can pre-fill sensible defaults for `analysis` / `direction` /
`completion` instead of asking the user from scratch.

> **Pure detection.** Only `node:fs/promises` + `node:path`. Never executes a
> command. Never throws — missing or unreadable files are treated as absent.

## Install (workspace-local)

```jsonc
// in another package
{
  "dependencies": {
    "@retry-now/detect": "workspace:*"
  }
}
```

## Public API

```ts
export interface WorkspaceMember {
  readonly name: string; // crate/package name, or directory basename fallback
  readonly path: string; // POSIX-style path relative to root, e.g. "crates/vespera_core"
}

export interface DetectionResult {
  readonly ecosystems: readonly string[]; // all detected, priority-ordered, e.g. ["rust","node"]
  readonly primary: string | null;        // highest-priority ecosystem, or null when none detected
  readonly test: string;                   // best test command for primary, "" if none
  readonly lint: string;                   // best lint command, "" if none
  readonly bench: string;                  // best bench command, "" if none
  readonly isMonorepo: boolean;            // true when the primary ecosystem is a workspace
  readonly members: readonly WorkspaceMember[]; // primary-ecosystem workspace members, path-sorted; [] if none
  readonly notes: readonly string[];       // one human-readable line per decision
}

export async function detectCapabilities(root: string): Promise<DetectionResult>;
```

## Priority order

`rust > go > python > node`.

`ecosystems` lists every detected marker in that order. `primary` is the first
one (or `null` if none). `test`/`lint`/`bench` come **from the primary
ecosystem only** — a Rust workspace that also ships a `package.json` resolves
to `primary = "rust"` with cargo commands, while still surfacing `"node"` in
`ecosystems`.

## Detection table

| Ecosystem | Marker(s) | `test` | `lint` | `bench` |
|---|---|---|---|---|
| **rust** | `Cargo.toml` | `cargo test` | `cargo clippy --all-targets --all-features` **(always)** | `cargo bench` if `benches/` dir OR `[[bench]]` in `Cargo.toml` OR `criterion` in `Cargo.toml` — else `""` |
| **go** | `go.mod` | `go test ./...` | `go vet ./...` **(always)** | `""` (no convention) |
| **python** | `pyproject.toml`, `setup.py`, `setup.cfg`, or `requirements.txt` | `pytest` if `tests/` dir OR `test_*.py` at root OR `pytest` mentioned in pyproject/setup.cfg/requirements — else `""` | `ruff check .` if `ruff.toml`/`.ruff.toml`/`ruff` in pyproject — else `flake8` if `.flake8`/`flake8` in pyproject/setup.cfg — else `""` | `pytest --benchmark-only` if `pytest-benchmark` in pyproject/requirements — else `""` |
| **node** | `package.json` | `scripts.test` → `<run> test`; else `vitest run` if `vitest` dep; else `jest` if `jest` dep; else `""` | `scripts.lint` → `<run> lint`; else `oxlint` (file/dep); else `biome lint .` (file/dep); else `eslint .` (file/dep); else `""` | `scripts.bench` → `<run> bench`; else `""` |

### Rust special case — clippy is always chosen

Unlike eslint/ruff/flake8, clippy ships with the Rust toolchain. There is **no
config-file gate** to wait for. `lint` is therefore `cargo clippy
--all-targets --all-features` for every Rust project; the detector emits an
explicit `notes` entry calling this out.

### Node package-manager resolution

Lockfile at `root` determines the run prefix:

| Lockfile | Manager | Prefix |
|---|---|---|
| `bun.lock` or `bun.lockb` | `bun` | `bun run` |
| `pnpm-lock.yaml` | `pnpm` | `pnpm run` |
| `yarn.lock` | `yarn` | `yarn` (bare — yarn has no `run`) |
| _(none of the above)_ | `npm` | `npm run` |

## Monorepo / workspace members

When the **primary** ecosystem is a workspace, `isMonorepo` is `true` and `members`
lists its packages (path-sorted). The CLI's `init` uses this to offer "whole-repo
vs per-package (분할) 윤회" and a multi-select of members.

| Primary | Source | Member resolution |
|---|---|---|
| **rust** | `[workspace] members = [...]` in root `Cargo.toml` | each pattern expanded; `prefix/*` → immediate subdirs containing a `Cargo.toml`; literal paths kept if they contain a `Cargo.toml`; `[workspace] exclude = [...]` honored; `name` from the member's `[package] name` (fallback: dir basename) |
| **node** | `workspaces` array (or `{ "packages": [...] }`) in root `package.json` | same `prefix/*` expansion against `package.json`; `name` from the member's `package.json` `name` (fallback: dir basename) |
| go / python | — | not a workspace here → `members = []`, `isMonorepo = false` |

Member `path`s are POSIX-style and relative to `root`. Only single-level `prefix/*`
globs are expanded (the common Cargo/npm case).

## Failure behaviour

| Situation | Behaviour |
|---|---|
| `root` does not exist | `primary=null`, all commands `""`, single note explaining no markers found |
| `Cargo.toml` / `package.json` unreadable | Marker still counts as present; content-derived signals (e.g. `criterion`, `vitest`, `scripts.test`) treated as absent |
| `package.json` is invalid JSON | Same as above: ecosystem detected, but no test/lint/bench commands |
| `pyproject.toml` is binary garbage | Treated as empty string — no `pytest`/`ruff`/`flake8` mentions detected |

The detector NEVER throws.

## `notes`

Every non-empty command and the Rust "always clippy" decision push a short
human-readable string into `notes` (one entry per decision). The CLI surfaces
this list so the user can see *why* a command was suggested.

## Test cases

`detect.test.ts` covers, with temp dirs under the OS temp dir, cleaned up after
each test:

1. **empty directory** — `primary=null`, every command is `""`.
2. **Rust: `Cargo.toml` alone** — `primary=rust`, `test=cargo test`,
   `lint=cargo clippy --all-targets --all-features`, `bench=""`, plus an
   `ALWAYS` note for clippy.
3. **Rust: `benches/` directory** — `bench=cargo bench` with the `benches/`
   reason in notes.
4. **Rust: `criterion` mentioned in `Cargo.toml`** — `bench=cargo bench`.
5. **Rust: `[[bench]]` section in `Cargo.toml`** — `bench=cargo bench`.
6. **Node + `bun.lock` + `scripts.{test,lint,bench}`** — `bun run test`,
   `bun run lint`, `bun run bench`; package-manager note mentions `bun`.
7. **Node + `oxlint.config.ts`, no scripts** — `lint=oxlint`, `test=""`,
   `bench=""`.
8. **Node + `biome.json`, no scripts** — `lint=biome lint .`.
9. **Python: `pyproject.toml` + `tests/`** — `primary=python`, `test=pytest`.
10. **Go: `go.mod`** — `primary=go`, `test=go test ./...`,
    `lint=go vet ./...`, `bench=""`.
11. **Priority: Rust + Node together** — `primary=rust`,
    `ecosystems=["rust","node"]`, commands come from rust (cargo), not node.
12. **Garbage `package.json`** — ecosystem still detected as `node`, but every
    command is `""` (graceful failure — never throws).
13. **Rust workspace** — `members = ["crates/*", "libs/bridge"]` resolves to the
    real member dirs (those containing a `Cargo.toml`), path-sorted, names from
    each member's `[package] name`; `isMonorepo=true`.
14. **Node workspace** — `workspaces = ["packages/*"]` resolves member dirs with
    their `package.json` `name`; `isMonorepo=true`.
15. **Non-workspace `Cargo.toml`** — `isMonorepo=false`, `members=[]`.
16. **Empty dir** — `isMonorepo=false`, `members=[]`.

Run them:

```bash
bun test
```
