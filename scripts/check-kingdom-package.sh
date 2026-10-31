#!/usr/bin/env bash
# Builds and packs the Kingdom package, installs the tarball in an empty folder and runs it there, so a dependency
# that only resolves inside the workspace fails here instead of on someone's machine.
set -euo pipefail
cd "$(dirname "$0")/.."
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

pnpm --filter @crystal-bridge/kingdom build
pnpm --filter @crystal-bridge/kingdom pack --pack-destination "$work" >/dev/null
tarball=$(echo "$work"/*.tgz)

contents=$(tar -tzf "$tarball" | sort | tr '\n' ' ')
expected='package/dist/LICENSE package/dist/main.js package/package.json '
[[ $contents == "$expected" ]] || { echo "check: unexpected package contents: $contents" >&2; exit 1; }

want=$(node -p "require('./apps/crystal/package.json').version")
cd "$work"
npm init -y >/dev/null
npm install --silent --no-audit --no-fund "$tarball"
got=$(node_modules/.bin/crystal-bridge-kingdom --version)
[[ $got == "$want" ]] || { echo "check: installed package says $got, expected $want" >&2; exit 1; }
# The update path loads these only when it needs them, so running the package above wouldn't show one missing.
node --input-type=module -e "await import('@sigstore/verify'); await import('@sigstore/bundle'); await import('@sigstore/tuf')"
echo "check: @crystal-bridge/kingdom $got installs and runs"
