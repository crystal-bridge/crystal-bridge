import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const BACKUP_NAME = /^airship-\d{8}-\d{6}\.db$/;

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
