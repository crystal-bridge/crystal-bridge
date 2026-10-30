import { backupStore } from './backup.js';

// Run nightly by deploy/airship/airship-backup.timer.
const dbPath = process.env.AIRSHIP_DB ?? './airship.db';
const dir = process.env.AIRSHIP_BACKUP_DIR ?? './backups';
const keep = Number(process.env.AIRSHIP_BACKUP_KEEP ?? '14');

backupStore(dbPath, dir, { keep })
  .then((path) => console.log(`[airship] backed up ${dbPath} to ${path} (keeping ${keep})`))
  .catch((error: unknown) => {
    console.error('[airship] backup failed', error);
    process.exit(1);
  });
