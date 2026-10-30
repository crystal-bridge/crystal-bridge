#!/usr/bin/env bash
# Ships the pushed main to an Airship host over SSH and (re)starts it there. Safe to re-run.
# Usage: scripts/deploy-airship.sh <ssh-host> [allowed-tailnet-login] [--branch] [--rollback]
# The host needs Node 22+, pnpm, passwordless sudo and Tailscale. Nothing is pulled from GitHub there.
# --rollback switches the host back to its previous release instead of shipping; see scripts/lib/deploy.sh.
set -euo pipefail
source "$(dirname "$0")/lib/deploy.sh"
cb_parse "$@"

host=${cb_args[0]:?usage: scripts/deploy-airship.sh <ssh-host> [allowed-tailnet-login] [--branch] [--rollback]}
allowed=${cb_args[1]:-}

if [[ $cb_rollback == yes ]]; then
  ssh "$host" bash -s <<REMOTE
set -euo pipefail
$CB_PREVIOUS_RELEASE
prev=\$(previous_release /opt/crystal-bridge) || { echo "deploy: no previous release to roll back to" >&2; exit 1; }
sudo ln -sfn "\$prev" /opt/crystal-bridge/current
sudo systemctl restart airship.service
port=\$(sudo sed -n 's/^AIRSHIP_PORT=//p' /etc/crystal-bridge/airship.env)
for _ in \$(seq 1 30); do curl -fsS "http://127.0.0.1:\${port:-7700}/api/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://127.0.0.1:\${port:-7700}/api/health" >/dev/null || { sudo journalctl -u airship -n 30 --no-pager; exit 1; }
echo "deploy: rolled back to \$(basename "\$prev")"
REMOTE
  exit 0
fi

cb_require_shippable
sha=$(git rev-parse --short=12 HEAD)
release=/opt/crystal-bridge/releases/$sha

echo "deploy: shipping $sha to $host"
git archive --format=tar HEAD | ssh "$host" "sudo mkdir -p $release && sudo tar -x -C $release"

ssh "$host" bash -s -- "$release" "$allowed" <<'REMOTE'
set -euo pipefail
# ssh joins its arguments into one string, so an empty login arrives as no argument at all.
release=$1 allowed=${2:-}

# One-time setup: a system user that owns only its data directory.
getent passwd airship >/dev/null || sudo useradd --system --home /var/lib/airship --shell /usr/sbin/nologin airship
sudo install -d -o airship -g airship -m 0700 /var/lib/airship
sudo install -d -m 0755 /etc/crystal-bridge
if [[ ! -f /etc/crystal-bridge/airship.env ]]; then
  sudo install -o root -g airship -m 0640 "$release/deploy/airship/airship.env.example" /etc/crystal-bridge/airship.env
fi
if [[ -n $allowed ]]; then
  sudo sed -i "s|^AIRSHIP_ALLOWED_USERS=.*|AIRSHIP_ALLOWED_USERS=$allowed|" /etc/crystal-bridge/airship.env
fi
if ! sudo grep -q '^AIRSHIP_ALLOWED_USERS=.\+' /etc/crystal-bridge/airship.env; then
  echo "deploy: set AIRSHIP_ALLOWED_USERS (pass it as the second argument) before the hub goes on the tailnet" >&2
  exit 1
fi

# Build the release in place; the service runs it read-only.
cd "$release"
# The hub reports this id in /api/health, and the web build embeds it, so open tabs can tell they're outdated.
basename "$release" | sudo tee RELEASE >/dev/null
sudo pnpm install --frozen-lockfile --config.confirmModulesPurge=false >/dev/null
sudo env CB_RELEASE="$(basename "$release")" pnpm --filter @crystal-bridge/web build >/dev/null

sudo ln -sfn "$release" /opt/crystal-bridge/current
sudo install -m 0644 deploy/airship/airship.service deploy/airship/airship-backup.service \
  deploy/airship/airship-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now airship-backup.timer >/dev/null
sudo systemctl enable airship.service >/dev/null
sudo systemctl restart airship.service

# Only HTTPS on the tailnet reaches it; the hub itself stays on 127.0.0.1.
port=$(sudo sed -n 's/^AIRSHIP_PORT=//p' /etc/crystal-bridge/airship.env)
sudo tailscale serve --bg --https=443 "http://127.0.0.1:${port:-7700}" >/dev/null

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${port:-7700}/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://127.0.0.1:${port:-7700}/api/health" >/dev/null || { sudo journalctl -u airship -n 30 --no-pager; exit 1; }

# Keep the three newest releases.
ls -1dt /opt/crystal-bridge/releases/* | tail -n +4 | xargs -r sudo rm -rf
echo "deploy: $(basename "$release") is live at https://$(tailscale status --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
REMOTE
