#!/usr/bin/env bash
#
# Publish the CURRENT workspace package to npm using OIDC Trusted Publishing.
#
# changepacks invokes this in each package's own directory and appends
# `--dry-run` for its dry-run gate; we forward "$@" so that flag reaches
# `npm publish`.
#
# Why this shape (resolve workspace:* ourselves -> npm pack -> npm publish):
#   - `bun publish` cannot perform the npm OIDC token exchange
#     (oven-sh/bun#15601) — under tokenless OIDC CI it fails with
#     "error: missing authentication (run `bunx npm login`)".
#   - `bun pm pack` DOES rewrite `workspace:*`, but it resolves the version from
#     bun.lock's cached workspace versions, which go STALE after
#     `changepacks update` bumps each package.json `version` without re-syncing
#     the lockfile. That shipped tarballs pinning `@retry-now/core@0.1.0` (a
#     version that was never published) and made every internal package
#     uninstallable — the exact bug this script now prevents.
#   - a bare `npm publish` from a package dir would ship the literal
#     `"@retry-now/core": "workspace:*"`, which npm cannot install.
#
#   So we resolve `workspace:*` ourselves from the LIVE packages/*/package.json
#   (deterministic, lockfile-independent — see scripts/resolve-workspace-deps.mjs),
#   `npm pack` the result (dist-only per each package's `files`), then hand the
#   finished tarball to `npm publish`, which merely uploads it under OIDC — it
#   does not re-resolve dependencies from a prebuilt tarball.
#
# OIDC requirements (handled by the workflow, not here):
#   - `permissions: id-token: write`
#   - npm CLI >= 11.5.1 (Node 24.0.0 ships 11.3.0, so the workflow runs
#     `npm install -g npm@latest`)
#   - each package configured with a Trusted Publisher on npmjs.com
#   Provenance is generated automatically under OIDC — no `--provenance` flag.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tarball=""

# Always restore the pristine package.json (with its workspace:* specs) and drop
# any tarball, even if pack/publish fails — the working tree must never keep the
# resolved concrete-version pins or a stray *.tgz.
cleanup() {
  if [[ -f package.json.orig ]]; then
    mv -f package.json.orig package.json
  fi
  if [[ -n "${tarball}" && -f "${tarball}" ]]; then
    rm -f "${tarball}"
  fi
}
trap cleanup EXIT

# 1. Snapshot, then rewrite workspace:* internal deps -> concrete versions read
#    from the live package.json files (NOT bun.lock, which goes stale).
cp package.json package.json.orig
node "${repo_root}/scripts/resolve-workspace-deps.mjs" package.json

# 2. Pack with npm (respects the `files` field; no workspace: protocol remains,
#    so no dependency resolution — npm just archives dist + manifest).
npm pack --loglevel warn >/dev/null

# 3. Locate the freshly produced tarball in the current package directory.
tarball="$(ls -1t ./*.tgz | head -n1)"
if [[ -z "${tarball}" || ! -f "${tarball}" ]]; then
  echo "publish-oidc: no tarball produced by 'npm pack'" >&2
  exit 1
fi

# 4. Upload the prebuilt tarball via npm (OIDC auth is automatic in CI).
#    --access public: @retry-now/* are scoped; ensure public visibility.
#    "$@" forwards changepacks' --dry-run during the dry-run gate.
npm publish "${tarball}" --access public "$@"
