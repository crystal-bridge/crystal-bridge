#!/usr/bin/env bash
# Issues a node token on the Airship host and restarts the hub so it takes effect.
# Usage: scripts/airship-node-add.sh <ssh-host> <node-id>
# The token is printed once: set it as CRYSTAL_TOKEN on that node.
set -euo pipefail
host=${1:?usage: scripts/airship-node-add.sh <ssh-host> <node-id>}
node=${2:?usage: scripts/airship-node-add.sh <ssh-host> <node-id>}
ssh "$host" bash -s -- "$node" <<'REMOTE'
set -euo pipefail
cd /opt/crystal-bridge/current/apps/airship
sudo -u airship env AIRSHIP_NODES=/var/lib/airship/nodes.json /opt/crystal-bridge/current/node_modules/.bin/tsx src/nodes-cli.ts add "$1"
sudo systemctl restart airship.service
REMOTE
