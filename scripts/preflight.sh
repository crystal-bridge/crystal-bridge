#!/usr/bin/env bash
# Crystal Bridge preflight: checks this machine is ready to run `pnpm dev`.
#
# Must work on both macOS's shipped bash (3.2) and Linux bash, so this avoids
# bash-4+-only features (no associative arrays, no `${var,,}`, no `read -d`, etc).
# It never reads any credential file; it only runs `node -v`, `pnpm -v` and
# `claude --version`.

set -eu

fail() {
  echo "preflight: FAIL - $1" >&2
  exit 1
}

# --- node: 22 or newer -------------------------------------------------------

if ! command -v node >/dev/null 2>&1; then
  fail "node not found on PATH. Install Node.js 22 or newer, then try again."
fi

node_version_raw=$(node -v 2>/dev/null) || fail "'node -v' did not run cleanly."
node_major=$(echo "$node_version_raw" | sed -E 's/^v?([0-9]+)\..*/\1/')

case "$node_major" in
  ''|*[!0-9]*)
    fail "could not parse a major version from 'node -v' output ($node_version_raw)."
    ;;
esac

if [ "$node_major" -lt 22 ]; then
  fail "node $node_version_raw found, but 22 or newer is required. Install a newer Node.js and try again."
fi
echo "preflight: node $node_version_raw OK"

# --- pnpm: just needs to run --------------------------------------------------

if ! command -v pnpm >/dev/null 2>&1; then
  fail "pnpm not found on PATH. Run 'corepack enable' (Node 22 ships corepack) or install pnpm, then try again."
fi

pnpm_version=$(pnpm -v 2>/dev/null) || fail "'pnpm -v' did not run cleanly. Run 'corepack enable' or reinstall pnpm."
echo "preflight: pnpm $pnpm_version OK"

# --- claude: just needs to run -----------------------------------------------

if ! command -v claude >/dev/null 2>&1; then
  fail "claude not found on PATH. Install Claude Code (native installer, or 'npm i -g @anthropic-ai/claude-code'), then try again."
fi

claude_version=$(claude --version 2>/dev/null) || fail "'claude --version' did not run cleanly. Reinstall Claude Code and try again."
echo "preflight: claude $claude_version OK"

echo "preflight: all checks passed."
echo "preflight: if you haven't signed in yet, run 'claude' once by itself and finish its login flow before 'pnpm dev' -"
echo "preflight: this script never reads credential files, so it can't check sign-in status for you."
