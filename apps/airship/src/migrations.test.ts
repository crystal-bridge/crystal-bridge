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

  it('starts tracking seen Quests from when it upgrades, so older finished turns never count as unseen', () => {
    const db = new Database(path);
    db.exec(MIGRATIONS.slice(0, 8).join(';'));
    db.pragma('user_version = 8');
    const before = Date.now();
    migrate(db);
    const { at } = db.prepare('SELECT at FROM seen_floor').get() as { at: number };
    expect(at).toBeGreaterThanOrEqual(before - 1_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1_000);
    db.close();
  });

  it('adds Patrols and their runs to a database from before them, keeping what it had', () => {
    const db = new Database(path);
    db.exec(MIGRATIONS.slice(0, 9).join(';'));
    db.pragma('user_version = 9');
    db.exec(`INSERT INTO scouts VALUES ('n', 'quest-board', 0, '{}')`);
    migrate(db);
    db.exec(`
      INSERT INTO patrols VALUES ('n', 'sweep', 0, '{}');
      INSERT INTO patrol_runs (node, id, patrol, started_at, outcome, data) VALUES ('n', 'r', 'sweep', 1, 'running', '{}');
    `);
    expect(db.prepare('SELECT count(*) AS n FROM scouts').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT count(*) AS n FROM patrol_runs').get()).toEqual({ n: 1 });
    db.close();
  });

  it('adds a done mark to the runs a database already has, unmarked', () => {
    const db = new Database(path);
    db.exec(MIGRATIONS.slice(0, 10).join(';'));
    db.pragma('user_version = 10');
    db.exec(`INSERT INTO patrol_runs VALUES ('n', 'r', 'sweep', 1, 'finished', '{}')`);
    migrate(db);
    expect(db.prepare('SELECT id, done_at FROM patrol_runs').all()).toEqual([{ id: 'r', done_at: null }]);
    db.close();
  });

  it('leaves the Quests a database already has free to name themselves, with no plain name', () => {
    const db = new Database(path);
    db.exec(MIGRATIONS.slice(0, 11).join(';'));
    db.pragma('user_version = 11');
    db.exec(
      `INSERT INTO sessions (id, node, cwd, label, status, created_at) VALUES ('s', 'n', '/r', 'fix it', 'idle', 1)`,
    );
    migrate(db);
    expect(db.prepare('SELECT id, label, plain_label, label_by_hand FROM sessions').all()).toEqual([
      { id: 's', label: 'fix it', plain_label: null, label_by_hand: 0 },
    ]);
    db.close();
  });

  it('adds an errands table keyed by Kingdom and id, empty for a database that has Quests', () => {
    const db = new Database(path);
    db.exec(MIGRATIONS.slice(0, 12).join(';'));
    db.pragma('user_version = 12');
    db.exec(
      `INSERT INTO sessions (id, node, cwd, label, status, created_at) VALUES ('s', 'n', '/r', 'fix it', 'idle', 1)`,
    );
    migrate(db);
    const insert = `INSERT OR IGNORE INTO errands (node, id, title, body, state, left_by, created, updated) VALUES ('n', 'e', 't', '', 'open', 'you', 1, 1)`;
    db.exec(insert);
    db.exec(insert);
    expect(db.prepare('SELECT session, seq, project, closed FROM errands').all()).toEqual([
      { session: null, seq: null, project: null, closed: null },
    ]);
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('adds a deeds table keyed by Kingdom and prefixed id, empty for a database that has Quests', () => {
    const db = new Database(path);
    db.exec(MIGRATIONS.slice(0, 13).join(';'));
    db.pragma('user_version = 13');
    db.exec(
      `INSERT INTO sessions (id, node, cwd, label, status, created_at) VALUES ('s', 'n', '/r', 'fix it', 'idle', 1)`,
    );
    migrate(db);
    const insert = (node: string) =>
      db.exec(
        `INSERT INTO deeds (id, node, kind, at) VALUES ('turn:s:1', '${node}', 'turn', 1) ON CONFLICT DO NOTHING`,
      );
    insert('n');
    insert('n');
    insert('m');
    const rows = db.prepare(`SELECT * FROM deeds WHERE node = 'n'`).all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(db.prepare(`SELECT node FROM deeds WHERE node = 'm'`).all()).toHaveLength(1);
    // A conflict on the key is skipped, but a missing column is still refused, not hidden.
    expect(() =>
      db.exec(`INSERT INTO deeds (id, node, kind) VALUES ('turn:s:2', 'n', 'turn') ON CONFLICT (node, id) DO NOTHING`),
    ).toThrow(/NOT NULL/);
    // An ordinary rowid table: WITHOUT ROWID would copy the long text key into every index.
    expect(db.prepare('SELECT rowid FROM deeds').all()).toHaveLength(2);
    for (const column of [
      'session',
      'seq',
      'patrol',
      'project',
      'text',
      'detail',
      'outcome',
      'cost_usd',
      'duration_ms',
      'files',
      'prs',
    ]) {
      expect(rows[0]![column]).toBeNull();
    }
    expect(db.pragma('user_version', { simple: true })).toBe(14);
    const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'deeds'`).all();
    expect(indexes).toEqual(expect.arrayContaining([{ name: 'deeds_node_at' }, { name: 'deeds_node_project_at' }]));
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
