#!/usr/bin/env bash
# Deploys the pushed main everywhere: the hub first, then each Kingdom, then this Mac (when it is idle).
# What "everywhere" means lives outside the repo, in ~/.config/crystal-bridge/deploy.env, so no host names are
# committed and every clone and worktree sees the same file:
#   HUB_HOST=hub-host                                   # the hub's SSH host
#   KINGDOMS="node-a-host:node-a node-b-host:node-b"    # ssh-host:node-id for each Linux Kingdom
#   LOCAL_NODE=laptop                                   # optional: this Mac's node id, deployed with --when-idle
# Usage: scripts/deploy-all.sh [--dry-run] [--force] [--kingdoms-only]
#   --dry-run        print the deploy commands instead of running them
#   --force          passed to the Kingdom deploys: restart without waiting for Quests to finish their turn
#   --kingdoms-only  skip the hub
set -euo pipefail

config="$HOME/.config/crystal-bridge/deploy.env"
dry=no force=() hub=yes
for arg in "$@"; do
  case $arg in
    --dry-run) dry=yes ;;
    --force) force=(--force) ;;
    --kingdoms-only) hub=no ;;
    *) echo "deploy-all: unknown argument $arg" >&2; exit 2 ;;
  esac
done

if [[ ! -f $config ]]; then
  cat >&2 <<EOF
deploy-all: no deploy config yet. Create $config with:

  HUB_HOST=hub-host                                  # the hub's SSH host
  KINGDOMS="node-a-host:node-a node-b-host:node-b"   # ssh-host:node-id for each Linux Kingdom
  LOCAL_NODE=laptop                                  # optional: this Mac's node id

It stays outside the repo, so your host names are never committed.
EOF
  exit 2
fi

HUB_HOST='' KINGDOMS='' LOCAL_NODE=''
# shellcheck disable=SC1090
source "$config"
[[ -n $HUB_HOST ]] || { echo "deploy-all: set HUB_HOST in $config" >&2; exit 2; }
for kingdom in $KINGDOMS; do
  [[ $kingdom =~ ^[^:]+:[^:]+$ ]] || { echo "deploy-all: KINGDOMS entries are ssh-host:node-id, got '$kingdom'" >&2; exit 2; }
done

run() {
  if [[ $dry == yes ]]; then echo "$*"; else echo "deploy-all: $*" >&2; "$@"; fi
}

cd "$(dirname "$0")/.."
[[ $hub == yes ]] && run scripts/deploy-airship.sh "$HUB_HOST"
failed=()
for kingdom in $KINGDOMS; do
  run scripts/deploy-crystal.sh "${kingdom%%:*}" "${kingdom##*:}" "$HUB_HOST" ${force[@]+"${force[@]}"} ||
    failed+=("${kingdom##*:}")
done
if [[ -n $LOCAL_NODE ]]; then
  run scripts/deploy-crystal-macos.sh "$LOCAL_NODE" "$HUB_HOST" --when-idle || failed+=("$LOCAL_NODE")
fi
if ((${#failed[@]} > 0)); then
  echo "deploy-all: not deployed: ${failed[*]}" >&2
  exit 1
fi
