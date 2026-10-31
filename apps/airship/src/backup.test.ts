import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupStore, runBackup } from './backup.js';
import { openStore } from './store.js';

describe('backupStore', () => {
  let dir: string;
  let dbPath: string;
  let backups: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'airship-backup-'));
    dbPath = join(dir, 'airship.db');
    backups = join(dir, 'backups');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes a timestamped copy that opens with the same events, while the store stays open', async () => {
    const store = openStore(dbPath);
    const session = randomUUID();
    store.appendEvent({ node: 'n', session, seq: 0, ts: 1, type: 'claude.event', payload: { a: 1 } });

    const path = await backupStore(dbPath, backups, { now: new Date('2026-10-29T03:04:05Z') });
    store.close();

    expect(path).toBe(join(backups, 'airship-20261029-030405.db'));
    const copy = openStore(path);
    expect(copy.eventsSince(session, 0)).toHaveLength(1);
    copy.close();
  });

  it('keeps only the newest copies, and leaves other files alone', async () => {
    openStore(dbPath).close();
    writeFileSync(join(dir, 'unrelated.txt'), 'x');
    for (let day = 1; day <= 5; day++) {
      await backupStore(dbPath, backups, { now: new Date(`2026-10-0${day}T00:00:00Z`), keep: 3 });
    }
    writeFileSync(join(backups, 'notes.txt'), 'keep me');

    await backupStore(dbPath, backups, { now: new Date('2026-10-06T00:00:00Z'), keep: 3 });

    expect(readdirSync(backups).sort()).toEqual([
      'airship-20261004-000000.db',
      'airship-20261005-000000.db',
      'airship-20261006-000000.db',
      'notes.txt',
    ]);
  });

  it('runBackup finds the store and the backups in the same places the hub does', async () => {
    openStore(join(dir, 'airship.db')).close();
    await runBackup({ AIRSHIP_DATA: dir, AIRSHIP_BACKUP_KEEP: '3' });
    expect(readdirSync(join(dir, 'backups'))).toHaveLength(1);
  });
});
