#!/usr/bin/env bash
# Builds and packs the hub, installs the tarball in an empty folder and runs it there with token login, so a dependency
# or file that only resolves inside the workspace fails here instead of on someone's machine.
set -euo pipefail
cd "$(dirname "$0")/.."
work=$(mktemp -d)
hub_pid=''
cleanup() { [[ -z $hub_pid ]] || kill "$hub_pid" 2>/dev/null || true; rm -rf "$work"; }
trap cleanup EXIT

pnpm --filter @crystal-bridge/airship build >/dev/null
pnpm --filter @crystal-bridge/airship pack --pack-destination "$work" >/dev/null
tarball=$(echo "$work"/*.tgz)
want=$(node -p "require('./apps/airship/package.json').version")

cd "$work"
npm init -y >/dev/null
npm install --silent --no-audit --no-fund "$tarball"
bin=$work/node_modules/.bin/crystal-bridge-airship
got=$("$bin" --version)
[[ $got == "$want" ]] || { echo "check: installed hub says $got, expected $want" >&2; exit 1; }

export AIRSHIP_AUTH=token AIRSHIP_DATA=$work/data AIRSHIP_PORT=7795
token=$("$bin" token add ci | grep -E '^[A-Za-z0-9_-]{43}$')
"$bin" >"$work/hub.log" 2>&1 &
hub_pid=$!
base=http://127.0.0.1:$AIRSHIP_PORT
for _ in $(seq 1 60); do curl -sf "$base/api/health" >/dev/null && break; sleep 0.5; done

status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
[[ $(status "$base/") == 200 ]] || { echo 'check: the web app did not load' >&2; cat "$work/hub.log" >&2; exit 1; }
[[ $(status "$base/api/sessions") == 403 ]] || { echo 'check: the API answered without a login' >&2; exit 1; }
[[ $(status -H "Authorization: Bearer $token" "$base/api/sessions") == 200 ]] ||
  { echo 'check: a good token was refused' >&2; exit 1; }
curl -sf "$base/api/health" | grep -q "\"release\":\"$want\"" || { echo 'check: wrong release reported' >&2; exit 1; }
echo "check: @crystal-bridge/airship $got installs and runs"
