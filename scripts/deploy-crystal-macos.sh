#!/usr/bin/env bash
# Installs the pushed main as Crystal on THIS Mac, run as a launchd user agent, so the Mac is a Kingdom too.
# Usage: scripts/deploy-crystal-macos.sh <node-id> <airship-ssh-host> [--force] [--branch] [--rollback]
#                                        [--when-idle [--dry-run]]
# Like scripts/deploy-crystal.sh (releases under ~/.local/share/crystal-bridge, three kept, --rollback, waiting up
# to CRYSTAL_DRAIN_SECONDS for turns to finish), but local: no SSH to the node, launchd instead of systemd.
# The first run issues the node's token on the Airship and writes it straight into the env file; it is never
# printed. Needs Node 22+, pnpm, a signed-in `claude` and Tailscale on the Mac.
#
# --when-idle schedules the deploy instead of running it, so a Quest on this Mac can update its own Crystal: a
# one-off launchd job (outside the Crystal job, so the restart doesn't kill it) waits until no session is busy,
# deploys the commit pinned now, then removes itself. The Quest finishes its turn, Crystal restarts while it's
# idle, and the next follow-up resumes it. --dry-run (with --when-idle) runs the same hand-off under its own label
# but only logs the deploy it would run. See scripts/lib/when-idle.sh.
set -euo pipefail
source "$(dirname "$0")/lib/deploy.sh"

when_idle=no
dry_run=no
args=()
for arg in "$@"; do
  case $arg in
    --when-idle) when_idle=yes ;;
    --dry-run) dry_run=yes ;;
    *) args+=("$arg") ;;
  esac
done
cb_parse ${args[@]+"${args[@]}"}

usage='usage: scripts/deploy-crystal-macos.sh <node-id> <airship-ssh-host> [--force] [--branch] [--rollback]'
node=${cb_args[0]:?$usage}
airship=${cb_args[1]:?$usage}
drain=${CRYSTAL_DRAIN_SECONDS:-600}
mode=$([[ $cb_rollback == yes ]] && echo rollback || echo ship)
[[ $(uname -s) == Darwin ]] || { echo "deploy: this script is for macOS; use scripts/deploy-crystal.sh" >&2; exit 2; }
[[ $dry_run == no || $when_idle == yes ]] || { echo "deploy: --dry-run only goes with --when-idle" >&2; exit 2; }

if [[ $when_idle == yes ]]; then
  source "$(dirname "$0")/lib/when-idle.sh"
  cb_schedule_when_idle "$node" "$dry_run"
  exit 0
fi

# A Quest on this Mac runs under the Crystal this would restart: waiting for "no turn in progress" would wait
# on itself. Run it from a terminal between turns instead.
if [[ -n ${CRYSTAL_SESSION:-} && $cb_force != yes ]]; then
  echo "deploy: this is running inside a Crystal Bridge Quest on this Mac, whose turn would block its own deploy." >&2
  echo "deploy: run it from a terminal once the Quest is idle." >&2
  exit 2
fi

if [[ $mode == ship ]]; then
  cb_require_shippable
else
  cd "$(git rev-parse --show-toplevel)"
fi
repo=$(pwd)
sha=$(git rev-parse --short=12 HEAD)
base=$HOME/.local/share/crystal-bridge
env_file=$HOME/.config/crystal-bridge/crystal.env
label=dev.crystal-bridge.crystal
plist=$HOME/Library/LaunchAgents/$label.plist
# Not 7701, which `pnpm dev`'s Crystal uses on a development Mac.
port_default=7711

hub="wss://$(ssh "$airship" "tailscale status --json" | python3 -c 'import json,sys;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')/node"

if [[ $mode == ship ]]; then
  echo "deploy: installing $sha on this Mac as node \"$node\" (hub $hub)"
  mkdir -p "$base/releases/$sha"
  ship=(package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .nvmrc packages/protocol apps/crystal deploy/crystal)
  git archive --format=tar HEAD -- "${ship[@]}" | tar -x -C "$base/releases/$sha"
  release=$base/releases/$sha
else
  current=$(readlink "$base/current" || true)
  release=$(ls -1dt "$base"/releases/* | while read -r r; do [[ $r != "$current" ]] && { echo "$r"; break; }; done)
  [[ -n $release ]] || { echo "deploy: no previous release to roll back to" >&2; exit 1; }
  echo "deploy: rolling back to $(basename "$release")"
fi

if [[ $mode == ship ]] && ! grep -qs '^CRYSTAL_TOKEN=.' "$env_file"; then
  echo "deploy: issuing a token for \"$node\" on $airship"
  token=$("$repo/scripts/airship-node-add.sh" "$airship" "$node" | grep -E '^[A-Za-z0-9_-]{43}$')
  (umask 077 && mkdir -p "$(dirname "$env_file")" && printf 'CRYSTAL_TOKEN=%s\n' "$token" > "$env_file")
  unset token
fi

if [[ $mode == ship ]]; then
  node_bin=$(dirname "$(command -v node)")
  claude_bin=$(dirname "$(command -v claude)")
  [[ -x $node_bin/node && -x $node_bin/pnpm && -x $claude_bin/claude ]] || { echo "deploy: need node, pnpm and claude on PATH" >&2; exit 1; }
  path="$node_bin:$claude_bin:/usr/local/bin:/usr/bin:/bin"
  # Keep the token, default mode and port; rewrite the rest.
  token_line=$(grep '^CRYSTAL_TOKEN=' "$env_file")
  mode_line=$(grep '^CRYSTAL_DEFAULT_MODE=' "$env_file" || echo 'CRYSTAL_DEFAULT_MODE=auto')
  port_line=$(grep '^CRYSTAL_MCP_PORT=' "$env_file" || echo "CRYSTAL_MCP_PORT=$port_default")
  chrome_line=$(grep '^CRYSTAL_CHROME=' "$env_file" || true)
  engines_line=$(grep '^CRYSTAL_ENGINES=' "$env_file" || true)
  (umask 077 && printf '%s\n' "CRYSTAL_HUB=$hub" "CRYSTAL_NODE=$node" "$token_line" "$mode_line" "$port_line" ${chrome_line:+"$chrome_line"} ${engines_line:+"$engines_line"} "PATH=$path" > "$env_file")
  (cd "$release" && PATH=$path pnpm install --frozen-lockfile --filter crystal-bridge --filter '@crystal-bridge/kingdom...' >/dev/null)
fi

# Wait for quiet before switching releases, so giving up leaves the running version untouched.
port=$(sed -n 's/^CRYSTAL_MCP_PORT=//p' "$env_file")
busy_sessions() {
  curl -fsS "http://127.0.0.1:${port:-$port_default}/status" 2>/dev/null |
    python3 -c 'import json,sys; s=json.load(sys.stdin); r=s.get("reasons", {}); print(", ".join(f"{i} ({r[i]})" if i in r else i for i in s.get("busy", [])))' 2>/dev/null || true
}
if [[ $cb_force != yes ]] && launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
  waited=0
  while busy=$(busy_sessions) && [[ -n $busy ]]; do
    if ((waited >= drain)); then
      echo "deploy: still busy after ${drain}s: $busy" >&2
      echo "deploy: not restarting; re-run when they finish, or pass --force" >&2
      exit 3
    fi
    ((waited % 30 == 0)) && echo "deploy: waiting for sessions to finish their turn: $busy"
    sleep 5
    waited=$((waited + 5))
  done
fi

ln -sfn "$release" "$base/current"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/crystal-bridge"
sed "s|__HOME__|$HOME|g" "$release/deploy/crystal/crystal.plist" > "$plist"
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
# bootout returns before the old agent has gone; bootstrapping while it lingers fails with an I/O error.
for _ in $(seq 1 30); do
  launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1 || break
  sleep 0.5
done
launchctl bootstrap "gui/$(id -u)" "$plist"

if [[ $mode == ship ]]; then
  ls -1dt "$base"/releases/* | tail -n +4 | while read -r old; do rm -rf "$old"; done
fi

api="https://$(sed -E 's|^wss://([^/]+)/node$|\1|' <<<"$hub")/api/nodes"
for _ in $(seq 1 30); do
  if grep -q "\"$node\"" <<<"$(curl -fsS "$api" 2>/dev/null || true)"; then
    echo "deploy: $([[ $mode == ship ]] && echo "$sha is live" || echo "rollback is live"); the hub lists \"$node\" as connected"
    exit 0
  fi
  sleep 1
done
echo "deploy: the hub doesn't list \"$node\" yet; recent Crystal logs:" >&2
tail -n 30 "$HOME/Library/Logs/crystal-bridge/crystal.log" >&2
exit 1
