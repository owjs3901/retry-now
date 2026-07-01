#!/usr/bin/env bash
#
# Publish the CURRENT workspace package to npm using OIDC Trusted Publishing.
#
# Why this two-step (bun pack -> npm publish) exists:
#   changepacks detects bun.lock and would normally run `bun publish`, but bun
#   (as of 1.3.x) cannot perform the npm OIDC token exchange
#   (oven-sh/bun#15601) — under a tokenless OIDC CI it fails with
#   "error: missing authentication (run `bunx npm login`)".
#
#   `npm publish` DOES support OIDC Trusted Publishing, but npm does NOT rewrite
#   the `workspace:*` protocol our internal deps use, so a bare `npm publish`
#   from a package dir would ship an uninstallable `"@retry-now/core": "workspace:*"`.
#
#   So: let bun PACK (it resolves workspace:* -> concrete versions and ships
#   dist-only per each package's `files`), then hand the finished tarball to
#   `npm publish`, which merely uploads it under OIDC — it does not re-resolve
#   dependencies from a prebuilt tarball.
#
# OIDC requirements (handled by the workflow, not here):
#   - `permissions: id-token: write`
#   - npm CLI >= 11.5.1 (Node 24.0.0 ships 11.3.0, so the workflow runs
#     `npm install -g npm@latest`)
#   - each package configured with a Trusted Publisher on npmjs.com
#   Provenance is generated automatically under OIDC — no `--provenance` flag.
#
# changepacks runs this in each package's own directory and appends `--dry-run`
# for its dry-run gate; we forward "$@" so that flag reaches `npm publish`.
set -euo pipefail

# 1. Pack with bun (resolves workspace:* -> concrete versions, dist-only).
bun pm pack --quiet

# 2. Locate the freshly produced tarball in the current package directory.
tarball="$(ls -1t ./*.tgz | head -n1)"
if [[ -z "${tarball}" || ! -f "${tarball}" ]]; then
  echo "publish-oidc: no tarball produced by 'bun pm pack'" >&2
  exit 1
fi

# 3. Upload the prebuilt tarball via npm (OIDC auth is automatic in CI).
#    --access public: @retry-now/* are scoped; ensure public visibility.
#    "$@" forwards changepacks' --dry-run during the dry-run gate.
npm publish "${tarball}" --access public "$@"

# 4. Clean up the tarball so it never lingers in the workspace.
rm -f "${tarball}"
