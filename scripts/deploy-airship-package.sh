#!/usr/bin/env bash
# Puts a published release on a hub host: the move off a checkout deploy, and every update after it.
# Usage: scripts/deploy-airship-package.sh <ssh-host> <version>
# The host stays as scripts/deploy-airship.sh set it up: same env file, data, backups and `tailscale serve`. Only what
# runs changes. The tarball's build provenance is checked here with `gh`, so this machine needs that, signed in, and the
# host needs npm. If the new hub doesn't come up, the old release and units go back. A plain deploy-airship.sh returns
# to running from a checkout.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/lib/airship-package.sh

usage='usage: scripts/deploy-airship-package.sh <ssh-host> <version>'
host=${1:?$usage}
version=${2:?$usage}
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo "deploy: not a version: $version" >&2; exit 2; }
repo=${CB_RELEASE_REPO:-crystal-bridge/crystal-bridge}
name=crystal-bridge-airship-$version.tgz

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL -o "$work/$name" "https://github.com/$repo/releases/download/v$version/$name"
gh attestation verify "$work/$name" --repo "$repo" --signer-workflow "$repo/.github/workflows/release.yml" \
  --source-ref "refs/tags/v$version" >/dev/null
echo "deploy: $name is this project's build of v$version"

cb_package_unit deploy/airship/airship.service >"$work/airship.service"
cb_package_unit deploy/airship/airship-backup.service >"$work/airship-backup.service"
cp deploy/airship/airship-backup.timer deploy/airship/push-backups.sh "$work/"

stage=$(ssh "$host" mktemp -d)
tar -C "$work" -cf - . | ssh "$host" tar -xf - -C "$stage"
ssh "$host" bash -s -- "$version" "$stage" "$name" <<'REMOTE'
set -euo pipefail
version=$1 stage=$2 name=$3
trap 'rm -rf "$stage"' EXIT
release=/opt/crystal-bridge/releases/$version
units=/etc/systemd/system

sudo rm -rf "$release"
sudo install -d "$release"
echo '{"private":true}' | sudo tee "$release/package.json" >/dev/null
(cd "$release" && sudo npm install --silent --omit=dev --no-audit --no-fund "$stage/$name")
said=$(sudo -u airship "$release/node_modules/.bin/crystal-bridge-airship" --version)
[[ $said == "$version" ]] || { echo "deploy: the release says it is $said" >&2; exit 1; }
sudo install -m 0755 "$stage/push-backups.sh" "$release/push-backups.sh"

saved=$stage/saved
mkdir "$saved"
previous=$(readlink /opt/crystal-bridge/current)
sudo cp "$units/airship.service" "$units/airship-backup.service" "$saved/"
restore() {
  echo "deploy: the hub didn't come up on $version; going back to $(basename "$previous")" >&2
  sudo journalctl -u airship -n 30 --no-pager >&2
  sudo install -m 0644 "$saved/airship.service" "$saved/airship-backup.service" "$units/"
  sudo ln -sfn "$previous" /opt/crystal-bridge/current
  sudo systemctl daemon-reload
  sudo systemctl restart airship.service
  exit 1
}

sudo ln -sfn "$release" /opt/crystal-bridge/current
sudo install -m 0644 "$stage/airship.service" "$stage/airship-backup.service" "$stage/airship-backup.timer" "$units/"
sudo systemctl daemon-reload
sudo systemctl restart airship.service

port=$(sudo sed -n 's/^AIRSHIP_PORT=//p' /etc/crystal-bridge/airship.env)
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${port:-7700}/api/health" 2>/dev/null | grep -q "\"release\":\"$version\""; then
    # Keep the three newest releases.
    ls -1dt /opt/crystal-bridge/releases/* | tail -n +4 | xargs -r sudo rm -rf
    echo "deploy: $version is live"
    exit 0
  fi
  sleep 1
done
restore
REMOTE
