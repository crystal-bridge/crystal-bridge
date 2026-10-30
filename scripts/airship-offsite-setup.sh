#!/usr/bin/env bash
# One-time setup for off-box Airship backups, run from a machine that can SSH to both hosts.
# Usage: scripts/airship-offsite-setup.sh <airship-ssh-host> <backup-ssh-host> <backup-user@address> <backup-dir>
#   e.g. scripts/airship-offsite-setup.sh hub-host backup-host root@192.0.2.10 /srv/backups/airship
# Gives the Airship's `airship` user its own SSH key and authorizes it on the backup host only for one forced
# command: an rsync receive into <backup-dir>. The key gets no shell, can't read anything back, and can't pick
# another path. (rrsync would do the same, but it needs Python, which some NAS systems lack.) Safe to re-run.
set -euo pipefail
airship=${1:?usage: see header} backup=${2:?usage: see header} target=${3:?usage: see header} dir=${4:?usage: see header}
address=${target#*@}

echo "offsite: making a key for the airship user on $airship"
pubkey=$(ssh "$airship" "command -v rsync >/dev/null || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq rsync >/dev/null
  sudo -u airship install -d -m 0700 /var/lib/airship/.ssh
  sudo -u airship test -f /var/lib/airship/.ssh/id_ed25519 ||
    sudo -u airship ssh-keygen -q -t ed25519 -N '' -C airship-backup@\$(hostname) -f /var/lib/airship/.ssh/id_ed25519
  sudo cat /var/lib/airship/.ssh/id_ed25519.pub")

echo "offsite: authorizing it on $backup for write-only access to $dir"
# The exact server command push-backups.sh's rsync asks for (rsync 3.x, -a --delete), with the path fixed.
# If a future rsync changes these flags, re-run this script.
entry="restrict,command=\"rsync --server -logDtpre.iLsfxCIvu --delete . ${dir%/}/\" $pubkey"
key=${pubkey#* }
key=${key%% *}
ssh "$backup" "mkdir -p '$dir' && chmod 700 '$dir'
  grep -vF '$key' ~/.ssh/authorized_keys > ~/.ssh/authorized_keys.new || true
  printf '%s\n' '$entry' >> ~/.ssh/authorized_keys.new
  cat ~/.ssh/authorized_keys.new > ~/.ssh/authorized_keys && rm ~/.ssh/authorized_keys.new"

# Pin the backup host's key to the one this machine already trusts, rather than trusting on first use.
known=$(ssh-keygen -F "$address" | grep -v '^#' || true)
if [[ -z $known ]]; then
  echo "offsite: $address is not in this machine's known_hosts; ssh to it once first" >&2
  exit 1
fi
printf '%s\n' "$known" | ssh "$airship" "sudo -u airship tee /var/lib/airship/.ssh/known_hosts >/dev/null"

ssh "$airship" "sudo sed -i 's|^AIRSHIP_BACKUP_SSH=.*|AIRSHIP_BACKUP_SSH=$target|' /etc/crystal-bridge/airship.env
  sudo grep -q '^AIRSHIP_BACKUP_SSH=' /etc/crystal-bridge/airship.env ||
    echo 'AIRSHIP_BACKUP_SSH=$target' | sudo tee -a /etc/crystal-bridge/airship.env >/dev/null"
echo "offsite: done; the next airship-backup run mirrors to $target:$dir"
