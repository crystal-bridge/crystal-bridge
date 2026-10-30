#!/usr/bin/env bash
# Runs `join` and `leave` from the packed tarball against a real hub and this machine's real service manager (systemd
# or launchd). Only `claude` is a stand-in: a login can't be copied. CI only, because it replaces the machine's
# Crystal service: on a real Kingdom it would stop the real one.
set -euo pipefail
[[ ${CI:-} == true ]] || { echo "check: CI only; this would replace this machine's Crystal service" >&2; exit 2; }
cd "$(dirname "$0")/.."
repo=$PWD
work=$(mktemp -d)
port=7795
hub=http://127.0.0.1:$port
hub_pid=''
cleanup() { [[ -z $hub_pid ]] || kill "$hub_pid" 2>/dev/null || true; rm -rf "$work"; }
trap cleanup EXIT

wait_for() { # <what> <command...>
  local what=$1 i
  shift
  for i in $(seq 1 60); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  echo "check: timed out waiting for $what" >&2
  return 1
}
connected() { curl -s "$hub/api/nodes" | grep -q ci-kingdom; }
disconnected() { ! connected; }

pnpm --filter @crystal-bridge/kingdom build
pnpm --filter @crystal-bridge/kingdom pack --pack-destination "$work" >/dev/null
tarball=$(echo "$work"/*.tgz)

mkdir "$work/bin"
cat > "$work/bin/claude" <<'FAKE'
#!/bin/sh
case "$*" in
  --version) echo '2.1.0 (Claude Code)' ;;
  'auth status') echo '{"loggedIn":true}' ;;
esac
FAKE
chmod +x "$work/bin/claude"

if [[ $(uname) == Linux ]]; then
  sudo loginctl enable-linger "$USER"
  export XDG_RUNTIME_DIR=/run/user/$(id -u)
  wait_for 'the user service manager' test -S "$XDG_RUNTIME_DIR/bus"
fi

(cd apps/airship && AIRSHIP_DEV=1 AIRSHIP_NODES=$work/nodes.json AIRSHIP_DB=$work/hub.db AIRSHIP_PORT=$port \
  exec "$repo/node_modules/.bin/tsx" src/main.ts) >"$work/hub.log" 2>&1 &
hub_pid=$!
wait_for 'the hub' curl -sf "$hub/api/health"

code=$(curl -s -X POST -H 'content-type: application/json' -d '{"node":"ci-kingdom"}' "$hub/api/join-codes" |
  node -p 'JSON.parse(require("fs").readFileSync(0)).code')

cd "$work"
PATH=$work/bin:$PATH npx --yes --package="$tarball" crystal-bridge-kingdom join "$hub" "$code"
rm -rf "$(npm config get cache)/_npx" # the service must not depend on npx's temporary copy

wait_for 'the Kingdom to connect through its service' connected
curl -s "$hub/api/engines" | grep -q '"cli":"2.1.0"' || { echo 'check: no CLI version reported' >&2; exit 1; }
echo 'check: the service connected'

main=$HOME/.local/share/crystal-bridge/current/node_modules/@crystal-bridge/kingdom/dist/main.js
node "$main" leave
wait_for 'the Kingdom to disconnect' disconnected
grep -q ci-kingdom "$work/nodes.json" && { echo 'check: the token survived leave' >&2; exit 1; }
[[ ! -e $HOME/.config/crystal-bridge/crystal.env ]] || { echo 'check: the env file survived leave' >&2; exit 1; }
[[ ! -e $HOME/.local/share/crystal-bridge ]] || { echo 'check: the install survived leave' >&2; exit 1; }
if [[ $(uname) == Linux ]]; then
  ! systemctl --user is-enabled crystal.service 2>/dev/null || { echo 'check: the service survived leave' >&2; exit 1; }
else
  ! launchctl print "gui/$(id -u)/dev.crystal-bridge.crystal" >/dev/null 2>&1 ||
    { echo 'check: the service survived leave' >&2; exit 1; }
fi
echo 'check: join and leave work on this machine'
