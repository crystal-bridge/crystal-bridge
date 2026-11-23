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
  // 10: Patrols (docs/PATROLS.md). Each Kingdom's Patrols in its order, and runs, the newest few per Patrol. A run is
  // reported when it sets out and again when it's back, under one id, so its row is updated in place.
  `
  CREATE TABLE patrols (
    node TEXT NOT NULL, id TEXT NOT NULL, ord INTEGER NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY (node, id)
  ) WITHOUT ROWID;
  CREATE TABLE patrol_runs (
    node TEXT NOT NULL, id TEXT NOT NULL, patrol TEXT NOT NULL, started_at INTEGER NOT NULL, outcome TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (node, id)
  );
  CREATE INDEX patrol_runs_patrol ON patrol_runs (node, patrol, started_at);
  `,
  // 11: a Patrol's run marked done on its Board (docs/PATROLS.md). The hub's own mark, apart from the run's data, so a
  // Kingdom reporting the run again doesn't undo it.
  `
  ALTER TABLE patrol_runs ADD COLUMN done_at INTEGER;
  `,
  // 12: Quest titles (#287). The plain form of a title a Quest gave itself, for the Classic theme, and whether the label
  // was set by hand, which a Quest's own title never overwrites.
  `
  ALTER TABLE sessions ADD COLUMN plain_label TEXT;
  ALTER TABLE sessions ADD COLUMN label_by_hand INTEGER NOT NULL DEFAULT 0;
  `,

  // 13: Errands (docs/ERRANDS.md, #288). Steps a Quest (or you) left, per Kingdom. A Quest's come from its
  // `errand.left` events, written only if no row has the key, so a repeat never refuses the event. `left_by` is quest
  // or you; `closed` is when it was last ticked done or dismissed, and the hub deletes those 30 days later.
  `
  CREATE TABLE errands (
    node TEXT NOT NULL, id TEXT NOT NULL, session TEXT, seq INTEGER, project TEXT,
    title TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL, left_by TEXT NOT NULL,
    created INTEGER NOT NULL, updated INTEGER NOT NULL, closed INTEGER,
    PRIMARY KEY (node, id)
  ) WITHOUT ROWID;
  CREATE INDEX errands_session ON errands (session, seq);
  `,
  // 14: Deeds (docs/DEEDS.md, #289). The feed's rows, per Kingdom: a turn record per turn.finished, a Deed per
  // deed.recorded, the call at Close's outcome per deeds.closing, and a script Patrol's finished or failed run. The id
  // is prefixed by its source (turn:, deed:, close:, run:), so the sources never meet, and keyed with its Kingdom: a
  // Kingdom picks its Deed and run ids, so one can never reach another's row. Rows from events are written only if
  // the Kingdom has no row with the id, so a repeat never refuses the event; `files` and `prs` (JSON) come later, with
  // the tally. An ordinary rowid table, not WITHOUT ROWID: rows are often 300-600 bytes (text, detail, prs JSON) with
  // a long text primary key that each secondary index would copy, and SQLite advises WITHOUT ROWID only for small rows.
  `
  CREATE TABLE deeds (
    node TEXT NOT NULL, id TEXT NOT NULL, session TEXT, seq INTEGER, patrol TEXT, project TEXT,
    kind TEXT NOT NULL, text TEXT, detail TEXT, outcome TEXT,
    cost_usd REAL, duration_ms INTEGER, files INTEGER, prs TEXT, at INTEGER NOT NULL,
    PRIMARY KEY (node, id)
  );
  CREATE INDEX deeds_node_at ON deeds (node, at);
  CREATE INDEX deeds_node_project_at ON deeds (node, project, at);
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
