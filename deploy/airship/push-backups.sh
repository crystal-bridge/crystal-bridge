#!/usr/bin/env bash
# Mirrors the Airship's local backups to an off-box host after each nightly backup (airship-backup.service).
# Does nothing unless AIRSHIP_BACKUP_SSH (user@host) is set. On the other end the key is locked to a single
# forced rsync receive into the backup directory (set up by scripts/airship-offsite-setup.sh), so the
# destination path given here is ignored there. --delete keeps the mirror to the same AIRSHIP_BACKUP_KEEP copies.
set -euo pipefail

if [[ -z ${AIRSHIP_BACKUP_SSH:-} ]]; then
  echo "[airship] AIRSHIP_BACKUP_SSH is not set; keeping backups on this machine only"
  exit 0
fi
ssh_dir=/var/lib/airship/.ssh
rsync -a --delete \
  -e "ssh -i $ssh_dir/id_ed25519 -o IdentitiesOnly=yes -o UserKnownHostsFile=$ssh_dir/known_hosts -o StrictHostKeyChecking=yes -o BatchMode=yes" \
  "${AIRSHIP_BACKUP_DIR:?}/" "$AIRSHIP_BACKUP_SSH:/"
echo "[airship] mirrored $AIRSHIP_BACKUP_DIR to $AIRSHIP_BACKUP_SSH"
