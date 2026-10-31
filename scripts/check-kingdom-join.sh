#!/usr/bin/env bash
# Runs `join`, a self-update, `rollback`, `leave` and `adopt` from the packed tarball against a real hub and this machine's real
# service manager (systemd or launchd). Only `claude` is a stand-in: a login can't be copied. The update is the real
# thing too: the build calls itself older, so it downloads and verifies a published release, which can't be faked and
# is why the target stays a release that exists. CI only, because it replaces the machine's Crystal service: on a real
# Kingdom it would stop the real one.
set -euo pipefail
[[ ${CI:-} == true ]] || { echo "check: CI only; this would replace this machine's Crystal service" >&2; exit 2; }
cd "$(dirname "$0")/.."
repo=$PWD
work=$(mktemp -d)
port=7795
hub=http://127.0.0.1:$port
hub_pid=''
old=0.1.0
target=0.2.0-alpha.1
manifest=$repo/apps/crystal/package.json
cp "$manifest" "$work/manifest"
cleanup() {
  [[ -z $hub_pid ]] || kill "$hub_pid" 2>/dev/null || true
  cp "$work/manifest" "$manifest"
  rm -rf "$work"
}
trap cleanup EXIT

wait_for() { # <what> <command...>; TRIES overrides the usual 30 s
  local what=$1 i
  shift
  for i in $(seq 1 "${TRIES:-60}"); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  echo "check: timed out waiting for $what" >&2
  return 1
}
connected() { curl -s "$hub/api/nodes" | grep -q ci-kingdom; }
disconnected() { ! connected; }
runs() { curl -s "$hub/api/engines" | grep -q "\"release\":\"$1\""; }
# GitHub limits anonymous API calls per address, and hosted runners share addresses. Only this exact failure passes.
rate_limited() { curl -s "$hub/api/engines" | grep -q 'failed its provenance check: GitHub answered 403'; }
updated_or_limited() { runs "$target" || rate_limited; }
service_log() {
  curl -s "$hub/api/engines" >&2 || true
  if [[ $(uname) == Linux ]]; then
    journalctl --user -u crystal.service --no-pager -n 40 >&2 || true
  else
    tail -n 40 "$HOME/Library/Logs/crystal-bridge/crystal.log" >&2 || true
  fi
}

node -e '
  const fs = require("fs");
  const [path, version] = process.argv.slice(1);
  fs.writeFileSync(path, JSON.stringify({ ...JSON.parse(fs.readFileSync(path, "utf8")), version }));
' "$manifest" "$old"
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
  AIRSHIP_KINGDOM_VERSION=$target \
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

not_deployed() { ! curl -s "$hub/api/nodes" | grep -q ci-deployed; }
base=$HOME/.local/share/crystal-bridge
entry=node_modules/@crystal-bridge/kingdom/dist/main.js
TRIES=360 wait_for "the Kingdom to update itself to $target" updated_or_limited || { service_log; exit 1; }
if rate_limited; then
  echo '::warning::GitHub rate-limited this runner, so the self-update and rollback checks were skipped'
  runs "$old" || { echo 'check: a failed update moved the Kingdom' >&2; exit 1; }
else
  [[ $(readlink "$base/current") == */releases/$target ]] ||
    { echo 'check: current is not the new release' >&2; exit 1; }
  echo 'check: the Kingdom updated itself, verified, through its service'

  node "$base/previous/$entry" rollback
  TRIES=120 wait_for "the Kingdom to roll back to $old" runs "$old" || { service_log; exit 1; }
  [[ $(cat "$base/held-version") == "$target" ]] || { echo 'check: rollback held nothing' >&2; exit 1; }
  echo 'check: rollback went back and held the release it left'
fi

node "$base/current/$entry" leave
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

# A Kingdom the deploy scripts made: their layout and their service, still running from an earlier release.
mkdir -p "$(dirname "$HOME/.config/crystal-bridge/crystal.env")" "$base/releases/abcdef123456"
code=$(curl -s -X POST -H 'content-type: application/json' -d '{"node":"ci-deployed"}' "$hub/api/join-codes" |
  node -p 'JSON.parse(require("fs").readFileSync(0)).code')
token=$(curl -s -X POST -H 'content-type: application/json' -d "{\"code\":\"$code\"}" "$hub/api/join" |
  node -p 'JSON.parse(require("fs").readFileSync(0)).token')
env_file=$HOME/.config/crystal-bridge/crystal.env
printf '%s\n' "CRYSTAL_HUB=${hub/http/ws}/node" CRYSTAL_NODE=ci-deployed "CRYSTAL_TOKEN=$token" CRYSTAL_SELF_UPDATE=off \
  "PATH=$work/bin:$(dirname "$(command -v node)"):/usr/bin:/bin" >"$env_file"
chmod 600 "$env_file"
ln -s "$base/releases/abcdef123456" "$base/current"
before=$(cat "$env_file")

PATH=$work/bin:$PATH npx --yes --package="$tarball" crystal-bridge-kingdom adopt
deployed() { curl -s "$hub/api/nodes" | grep -q ci-deployed; }
wait_for 'the adopted Kingdom to connect through its service' deployed
[[ $(cat "$env_file") == "$before" ]] || { echo 'check: adopt changed the env file' >&2; exit 1; }
[[ $(readlink "$base/current") == */releases/$old ]] || { echo 'check: adopt left current alone' >&2; exit 1; }
echo 'check: adopt moved a deployed Kingdom onto the package'
node "$base/current/$entry" leave
wait_for 'the adopted Kingdom to disconnect' not_deployed

echo 'check: join, self-update, rollback, leave and adopt work on this machine'
