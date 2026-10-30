import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate, pendingMigrations, SCHEMA_VERSION } from './migrations.js';

describe('store migrations', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'airship-migrations-'));
    path = join(dir, 'airship.db');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const version = (p: string) => new Database(p).pragma('user_version', { simple: true });

  it('brings a new database to the current version', () => {
    const db = new Database(path);
    migrate(db);
    db.close();
    expect(version(path)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(MIGRATIONS.length);
  });

  it('adopts a database created before versioning without losing data', () => {
    const old = new Database(path);
    old.exec(`
      CREATE TABLE events (session TEXT NOT NULL, seq INTEGER NOT NULL, node TEXT NOT NULL, ts INTEGER NOT NULL,
        type TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (session, seq)) WITHOUT ROWID;
      CREATE TABLE sessions (id TEXT PRIMARY KEY, node TEXT NOT NULL, cwd TEXT NOT NULL, label TEXT NOT NULL,
        status TEXT NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO sessions VALUES ('s', 'n', '/w', 'l', 'idle', 1);
    `);
    old.close();
    expect(pendingMigrations(path)).toBe(SCHEMA_VERSION);

    const db = new Database(path);
    migrate(db);
    expect(db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 1 });
    db.close();
    expect(pendingMigrations(path)).toBe(0);
  });

  it('repairs sessions that were closed but later marked ended', () => {
    const db = new Database(path);
    db.exec(MIGRATIONS.slice(0, 4).join(';'));
    db.pragma('user_version = 4');
    db.exec(`
      INSERT INTO sessions VALUES ('closed-then-ended', 'n', '/w', 'l', 'ended', 1), ('just-ended', 'n', '/w', 'l', 'ended', 2);
      INSERT INTO events VALUES ('closed-then-ended', 3, 'n', 3, 'session.closed', '{}');
    `);
    migrate(db);
    const status = (id: string) =>
      (db.prepare('SELECT status FROM sessions WHERE id = ?').get(id) as { status: string }).status;
    expect(status('closed-then-ended')).toBe('closed');
    expect(status('just-ended')).toBe('ended');
    db.close();
  });

  it('refuses a database written by newer code, e.g. after rolling back past a migration', () => {
    const db = new Database(path);
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    expect(() => migrate(db)).toThrow(/newer than this Airship/);
    db.close();
  });

  it('reports nothing pending for a missing database file, which needs no backup', () => {
    expect(pendingMigrations(join(dir, 'missing.db'))).toBe(0);
  });
});
