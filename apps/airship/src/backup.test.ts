import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { umask } from 'node:process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupRecord, backupStore, runBackup } from './backup.js';
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

  it.each([0, -3])('keeps the new copy even at keep %i', async (keep) => {
    openStore(dbPath).close();
    const path = await backupStore(dbPath, backups, { keep });
    expect(readdirSync(backups)).toEqual([basename(path)]);
  });

  it('finishes while the hub commits, though each commit restarts an online backup', async () => {
    const store = openStore(dbPath);
    const session = randomUUID();
    const bulk = 'x'.repeat(4000);
    for (let seq = 0; seq < 2000; seq++) {
      store.appendEvent({ node: 'n', session, seq, ts: 1, type: 'claude.event', payload: { bulk } });
    }
    let seq = 2000;
    let writing = true;
    const commits = async () => {
      while (writing) {
        store.appendEvent({ node: 'n', session, seq: seq++, ts: 1, type: 'claude.event', payload: {} });
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    const writer = commits();

    const finished = await Promise.race([
      backupStore(dbPath, backups).then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
    ]);
    writing = false;
    await writer;
    store.close();

    expect(finished).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('makes each copy private, and tightens older ones', async () => {
    openStore(dbPath).close();
    const previous = umask(0o022);
    try {
      const older = await backupStore(dbPath, backups, { now: new Date('2026-10-01T00:00:00Z') });
      chmodSync(older, 0o644);
      const newer = await backupStore(dbPath, backups, { now: new Date('2026-10-02T00:00:00Z') });
      expect(statSync(newer).mode & 0o777).toBe(0o600);
      expect(statSync(older).mode & 0o777).toBe(0o600);
    } finally {
      umask(previous);
    }
  });

  it('leaves no empty copy behind when the backup fails, which would pass for the newest', async () => {
    await expect(backupStore(join(dir, 'missing.db'), backups)).rejects.toThrow();
    expect(existsSync(backups) ? readdirSync(backups) : []).toEqual([]);

    writeFileSync(join(dir, 'broken.db'), 'not a database'.repeat(1000));
    await expect(backupStore(join(dir, 'broken.db'), backups)).rejects.toThrow();
    expect(readdirSync(backups)).toEqual([]);
  });

  it('runBackup finds the store and the backups in the same places the hub does', async () => {
    openStore(join(dir, 'airship.db')).close();
    await runBackup({ AIRSHIP_DATA: dir, AIRSHIP_BACKUP_KEEP: '3' });
    expect(readdirSync(join(dir, 'backups'))).toHaveLength(1);
  });
});

describe('backupRecord', () => {
  it('reads the newest copy from its name, and when the mirror last ran', () => {
    const dir = mkdtempSync(join(tmpdir(), 'airship-record-'));
    writeFileSync(join(dir, 'airship-20261029-030405.db'), '');
    writeFileSync(join(dir, 'airship-20261030-030405.db'), '');
    writeFileSync(join(dir, 'last-mirror'), '1793400000\n');
    expect(backupRecord(dir)).toEqual({
      lastBackupAt: Date.UTC(2026, 9, 30, 3, 4, 5),
      lastMirrorAt: 1793400000_000,
    });
  });

  it('says nothing about a backup or a mirror that has never run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'airship-record-'));
    expect(backupRecord(dir)).toEqual({});
    expect(backupRecord(join(dir, 'missing'))).toEqual({});
  });
});
