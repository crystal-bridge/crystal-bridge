import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';

/**
 * The store's schema, one entry per version: MIGRATIONS[0] takes a database to version 1, and so on. Never edit an
 * entry that has shipped; append a new one. SQLite's `user_version` records how far a database has got.
 */
export const MIGRATIONS: readonly string[] = [
  // 1: events and sessions. IF NOT EXISTS so it adopts databases created before versioning, as-is.
  `
  CREATE TABLE IF NOT EXISTS events (
    session TEXT NOT NULL, seq INTEGER NOT NULL, node TEXT NOT NULL, ts INTEGER NOT NULL,
    type TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY (session, seq)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, node TEXT NOT NULL, cwd TEXT NOT NULL, label TEXT NOT NULL,
    status TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  `,
  // 2: Web Push subscriptions, one per browser endpoint, with that device's notification prefs (JSON).
  `
  CREATE TABLE push_subscriptions (
    endpoint TEXT PRIMARY KEY, keys TEXT NOT NULL, prefs TEXT NOT NULL, updated_at INTEGER NOT NULL
  );
  `,
  // 3: each user's Kingdom appearance (icons, colours, tab style), shared across their devices; JSON, last write wins.
  `
  CREATE TABLE appearance (
    login TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL
  );
  `,
  // 4: bytes the hub has relayed to clients per session (all devices together), flushed in batches.
  `
  CREATE TABLE relay (
    session TEXT PRIMARY KEY, bytes INTEGER NOT NULL
  );
  `,
  // 5: repair Quests closed before a close stuck: their process's later end had set them back to ended or idle.
  `
  UPDATE sessions SET status = 'closed'
  WHERE status != 'closed' AND id IN (SELECT session FROM events WHERE type = 'session.closed');
  `,
  // 6: indexes for the home pages: recent events of a kind (stats, activity) and a session's latest of a kind (preview).
  `
  CREATE INDEX events_type_ts ON events (type, ts);
  CREATE INDEX events_session_type_seq ON events (session, type, seq);
  `,
  // 7: Casts, jobs a Kingdom runs on its Summons. `delivered` is set once the user or the Quest has been told it ended.
  `
  CREATE TABLE casts (
    id TEXT PRIMARY KEY, node TEXT NOT NULL, session TEXT NOT NULL, state TEXT NOT NULL,
    started_at INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL
  );
  CREATE INDEX casts_node_started ON casts (node, started_at);
  `,
  // 8: Scouts and their Boards (docs/SCOUTS.md). Each Kingdom's Scouts in its order; runs, the newest few per Scout; and
  // items keyed by the collector's own id, with the user's state apart from whether the latest list still has them.
  `
  CREATE TABLE scouts (
    node TEXT NOT NULL, id TEXT NOT NULL, ord INTEGER NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY (node, id)
  ) WITHOUT ROWID;
  CREATE TABLE scout_runs (
    node TEXT NOT NULL, id TEXT NOT NULL, scout TEXT NOT NULL, started_at INTEGER NOT NULL, outcome TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (node, id)
  );
  CREATE INDEX scout_runs_board ON scout_runs (node, scout, started_at);
  CREATE TABLE scout_items (
    node TEXT NOT NULL, scout TEXT NOT NULL, id TEXT NOT NULL, ord INTEGER NOT NULL, rev TEXT NOT NULL,
    state TEXT NOT NULL, until INTEGER, first_seen INTEGER NOT NULL, changed_at INTEGER NOT NULL, gone_at INTEGER,
    data TEXT NOT NULL,
    PRIMARY KEY (node, scout, id)
  ) WITHOUT ROWID;
  `,
  // 9: done until viewed. The latest event seq each login has had in view per Quest; a Quest whose latest finished turn
  // or failure is newer is unseen. Only outcomes after `seen_floor` count, so an upgrade doesn't mark all history unseen.
  `
  CREATE TABLE seen (
    login TEXT NOT NULL, session TEXT NOT NULL, seq INTEGER NOT NULL,
    PRIMARY KEY (login, session)
  ) WITHOUT ROWID;
  CREATE TABLE seen_floor (at INTEGER NOT NULL);
  INSERT INTO seen_floor VALUES (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

function versionOf(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/**
 * Applies every migration the database hasn't had, each in its own transaction. Refuses a database from newer
 * code (e.g. after rolling back past a migration) rather than run old code on a schema it doesn't know.
 */
export function migrate(db: Database.Database): void {
  const from = versionOf(db);
  if (from > SCHEMA_VERSION) {
    throw new Error(
      `database schema v${from} is newer than this Airship (v${SCHEMA_VERSION}); roll forward, or restore the ` +
        `backup taken before that migration`,
    );
  }
  for (let version = from + 1; version <= SCHEMA_VERSION; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version - 1]!);
      db.pragma(`user_version = ${version}`);
    })();
  }
}

/** How many migrations an existing database file still needs (0 for a missing file), so a backup can go first. */
export function pendingMigrations(path: string): number {
  if (path === ':memory:' || !existsSync(path)) return 0;
  const db = new Database(path, { readonly: true });
  try {
    return Math.max(0, SCHEMA_VERSION - versionOf(db));
  } finally {
    db.close();
  }
}
