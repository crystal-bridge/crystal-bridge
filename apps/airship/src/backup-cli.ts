import { runBackup } from './backup.js';

// Run nightly by deploy/airship/airship-backup.timer. A packaged hub has this as `crystal-bridge-airship backup`.
runBackup(process.env).catch((error: unknown) => {
  console.error('[airship] backup failed', error);
  process.exit(1);
});
