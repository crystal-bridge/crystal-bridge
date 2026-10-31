import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { hubPaths } from './paths.js';

const BACKUP_NAME = /^airship-\d{8}-\d{6}\.db$/;
const BACKUP_STAMP = /^airship-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/;

function stamp(now: Date): string {
  const iso = now.toISOString(); // 2026-10-29T03:04:05.000Z
  return `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}`;
}

/**
 * Copies the store with SQLite's online backup, which is safe while the Airship has it open, to
 * `<dir>/airship-YYYYMMDD-HHMMSS.db` (UTC), then deletes all but the newest `keep` copies. Other files
 * in `dir` are left alone. Returns the new copy's path.
 */
export async function backupStore(
  dbPath: string,
  dir: string,
  { now = new Date(), keep = 14 }: { now?: Date; keep?: number } = {},
): Promise<string> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, `airship-${stamp(now)}.db`);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    await db.backup(target);
  } finally {
    db.close();
  }

  const copies = readdirSync(dir)
    .filter((name) => BACKUP_NAME.test(name))
    .sort();
  for (const name of copies.slice(0, Math.max(0, copies.length - keep))) rmSync(join(dir, name));
  return target;
}

/** When the newest copy was made, and when the mirror last ran (`push-backups.sh` leaves `last-mirror`); only what's known. */
export function backupRecord(dir: string): { lastBackupAt?: number; lastMirrorAt?: number } {
  if (!existsSync(dir)) return {};
  const newest = readdirSync(dir)
    .filter((name) => BACKUP_NAME.test(name))
    .sort()
    .at(-1);
  const [y, mo, d, h, mi, sec] = (BACKUP_STAMP.exec(newest ?? '') ?? []).slice(1).map(Number);
  const mirror = join(dir, 'last-mirror');
  const mirrored = existsSync(mirror) ? Number(readFileSync(mirror, 'utf8').trim()) : NaN;
  return {
    ...(newest ? { lastBackupAt: Date.UTC(y!, mo! - 1, d, h, mi, sec) } : {}),
    ...(Number.isFinite(mirrored) ? { lastMirrorAt: mirrored * 1000 } : {}),
  };
}

/** One backup with the hub's own settings: the nightly job, and `crystal-bridge-airship backup`. */
export async function runBackup(env: NodeJS.ProcessEnv): Promise<void> {
  const { db, backups } = hubPaths(env);
  const keep = Number(env.AIRSHIP_BACKUP_KEEP ?? '14');
  const path = await backupStore(db, backups, { keep });
  console.log(`[airship] backed up ${db} to ${path} (keeping ${keep})`);
}
