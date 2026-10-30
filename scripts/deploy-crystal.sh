#!/usr/bin/env bash
# Ships the pushed main to a Kingdom over SSH and (re)starts Crystal there as a systemd user service.
# Usage: scripts/deploy-crystal.sh <ssh-host> <node-id> <airship-ssh-host> [--force] [--branch] [--rollback]
# --rollback switches the node back to its previous release (still waiting for turns); see scripts/lib/deploy.sh.
# A restart cuts off any turn in progress, so this waits (up to CRYSTAL_DRAIN_SECONDS, default 600) until no
# session on the node is mid-turn, including ones waiting on an approval. --force restarts without waiting.
# The first deploy issues the node's token on the Airship and writes it straight into the node's env file;
# it is never printed or stored here. The node needs Node 22+, pnpm, a signed-in `claude`, Tailscale and
# lingering enabled for its user (sudo loginctl enable-linger <user>), so the service runs without a login.
set -euo pipefail
source "$(dirname "$0")/lib/deploy.sh"
cb_parse "$@"

usage='usage: scripts/deploy-crystal.sh <ssh-host> <node-id> <airship-ssh-host> [--force] [--branch] [--rollback]'
host=${cb_args[0]:?$usage}
node=${cb_args[1]:?$usage}
airship=${cb_args[2]:?$usage}
force=$([[ $cb_force == yes ]] && echo --force || echo no)
drain=${CRYSTAL_DRAIN_SECONDS:-600}
mode=$([[ $cb_rollback == yes ]] && echo rollback || echo ship)
if [[ $mode == ship ]]; then
  cb_require_shippable
else
  cd "$(git rev-parse --show-toplevel)"
fi
sha=$(git rev-parse --short=12 HEAD)
base='$HOME/.local/share/crystal-bridge'
env_file='$HOME/.config/crystal-bridge/crystal.env'

if [[ $(ssh "$host" "loginctl show-user \$(id -un) -p Linger --value") != yes ]]; then
  echo "deploy: lingering is off for the node user; run: ssh $host 'sudo loginctl enable-linger \$(id -un)'" >&2
  exit 1
fi

hub="wss://$(ssh "$airship" "tailscale status --json" | python3 -c 'import json,sys;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')/node"

if [[ $mode == ship ]]; then
  echo "deploy: shipping $sha to $host as node \"$node\" (hub $hub)"
  # Only what Crystal runs: Kingdoms can belong to identities kept apart from this repo's, so no README,
  # CLAUDE.md, docs or plan (which name the repo's owner) go out.
  ship=(package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .nvmrc packages/protocol apps/crystal deploy/crystal)
  git archive --format=tar HEAD -- "${ship[@]}" | ssh "$host" "mkdir -p $base/releases/$sha && tar -x -C $base/releases/$sha"
fi

if [[ $mode == ship ]] && ! ssh "$host" "grep -qs '^CRYSTAL_TOKEN=.' $env_file"; then
  echo "deploy: issuing a token for \"$node\" on $airship"
  token=$(scripts/airship-node-add.sh "$airship" "$node" | grep -E '^[A-Za-z0-9_-]{43}$')
  printf 'CRYSTAL_TOKEN=%s\n' "$token" | ssh "$host" "umask 077 && mkdir -p \$(dirname $env_file) && cat > $env_file"
  unset token
fi

{ echo "$CB_PREVIOUS_RELEASE"; cat <<'REMOTE'; } | ssh "$host" bash -s -- "$sha" "$node" "$hub" "$drain" "$force" "$mode"
set -euo pipefail
sha=$1 node=$2 hub=$3 drain=$4 force=$5 mode=$6
base=$HOME/.local/share/crystal-bridge
env_file=$HOME/.config/crystal-bridge/crystal.env

if [[ $mode == rollback ]]; then
  release=$(previous_release "$base") || { echo "deploy: no previous release to roll back to" >&2; exit 1; }
  echo "deploy: rolling back to $(basename "$release")"
else

# nvm and ~/.local/bin are only on PATH in interactive shells; pin what they resolve to for the service.
node_bin=$(bash -lic 'dirname "$(command -v node)"' 2>/dev/null | tail -1)
claude_bin=$(bash -lic 'dirname "$(command -v claude)"' 2>/dev/null | tail -1)
[[ -x $node_bin/node && -x $node_bin/pnpm && -x $claude_bin/claude ]] || { echo "deploy: need node, pnpm and claude on $(hostname)" >&2; exit 1; }
path="$node_bin:$claude_bin:/usr/local/bin:/usr/bin:/bin"

# Keep the token and any chosen default mode (auto unless changed); rewrite the rest.
token_line=$(grep '^CRYSTAL_TOKEN=' "$env_file")
mode_line=$(grep '^CRYSTAL_DEFAULT_MODE=' "$env_file" || echo 'CRYSTAL_DEFAULT_MODE=auto')
umask 077
chrome_line=$(grep '^CRYSTAL_CHROME=' "$env_file" || true)
engines_line=$(grep '^CRYSTAL_ENGINES=' "$env_file" || true)
printf '%s\n' "CRYSTAL_HUB=$hub" "CRYSTAL_NODE=$node" "$token_line" "$mode_line" ${chrome_line:+"$chrome_line"} ${engines_line:+"$engines_line"} "PATH=$path" > "$env_file"

release=$base/releases/$sha
cd "$release"
PATH=$path pnpm install --frozen-lockfile --filter crystal-bridge --filter '@crystal-bridge/kingdom...' >/dev/null
fi
cd "$release"
# Wait for quiet before switching releases, so giving up leaves the running version untouched.
busy_sessions() {
  curl -fsS "http://127.0.0.1:${CRYSTAL_MCP_PORT:-7701}/status" 2>/dev/null |
    python3 -c 'import json,sys; s=json.load(sys.stdin); r=s.get("reasons", {}); print(", ".join(f"{i} ({r[i]})" if i in r else i for i in s.get("busy", [])))' 2>/dev/null || true
}
if [[ $force != --force ]] && systemctl --user is-active --quiet crystal.service; then
  waited=0
  while busy=$(busy_sessions) && [[ -n $busy ]]; do
    if ((waited >= drain)); then
      echo "deploy: still mid-turn after ${drain}s: $busy" >&2
      echo "deploy: not restarting; re-run when they finish, or pass --force" >&2
      exit 3
    fi
    ((waited % 30 == 0)) && echo "deploy: waiting for sessions to finish their turn: $busy"
    sleep 5
    waited=$((waited + 5))
  done
fi

ln -sfn "$release" "$base/current"

mkdir -p "$HOME/.config/systemd/user"
install -m 0644 deploy/crystal/crystal.service "$HOME/.config/systemd/user/crystal.service"
systemctl --user daemon-reload
systemctl --user enable crystal.service >/dev/null 2>&1
systemctl --user restart crystal.service

# An `if`, not `&&`: as the script's last command, a false test would fail the whole remote run.
if [[ $mode == ship ]]; then
  ls -1dt "$base"/releases/* | tail -n +4 | xargs -r rm -rf
fi
REMOTE

# The hub lists a node only once its token and hello check out. This runs on the Mac, over the tailnet,
# with the deployer's own tailnet login.
api="https://$(sed -E 's|^wss://([^/]+)/node$|\1|' <<<"$hub")/api/nodes"
for _ in $(seq 1 30); do
  if grep -q "\"$node\"" <<<"$(curl -fsS "$api" 2>/dev/null || true)"; then
    echo "deploy: $([[ $mode == ship ]] && echo "$sha is live" || echo "rollback is live"); the hub lists \"$node\" as connected"
    exit 0
  fi
  sleep 1
done
echo "deploy: the hub doesn't list \"$node\" yet; recent Crystal logs:" >&2
ssh "$host" "journalctl --user -u crystal -n 30 --no-pager" >&2
exit 1
