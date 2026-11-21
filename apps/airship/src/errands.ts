import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Errand, ErrandCreate, ErrandEdit, ErrandState } from '@crystal-bridge/protocol';

/** How long a closed Errand stays before the hub deletes it. */
export const ERRANDS_KEPT_MS = 30 * 24 * 60 * 60 * 1000;
/** Crystal's own worktree folder for a Quest: `<root>/.worktrees/<first 8 hex of the session id>` (worktree.ts). */
const WORKTREE = /[\\/]\.worktrees[\\/][0-9a-f]{8}[\\/]?$/;

/** An Errand's project: the repository's folder for a Quest in a worktree, so a Patrol's runs group together. */
export function errandProject(cwd: string, worktreeRoot?: string): string {
  return worktreeRoot ?? cwd.replace(WORKTREE, '');
}

export interface LeftErrand {
  node: string;
  id: string;
  session: string;
  seq: number;
  ts: number;
  project?: string;
  title: string;
  body: string;
}

/** The store's Errands (docs/ERRANDS.md), on the store's own database. */
export interface Errands {
  /** Writes an Errand a Quest left, unless one has its key already. Part of `appendEvent`'s transaction. */
  recordErrandLeft(left: LeftErrand): void;
  /** A Kingdom's Errands, open and closed, newest first. */
  errands(node: string): Errand[];
  /** Open Errands per Kingdom, for the Kingdom tabs; Kingdoms with none are left out. */
  openErrandCounts(): Record<string, number>;
  addErrand(node: string, errand: ErrandCreate, now: number): Errand;
  editErrand(node: string, id: string, edit: ErrandEdit, now: number): Errand | undefined;
  setErrandState(node: string, id: string, state: ErrandState, now: number): Errand | undefined;
  /** Deletes Errands closed at least ERRANDS_KEPT_MS before `now`; returns the Kingdoms that lost any. */
  purgeErrands(now: number): string[];
  /** Part of the store's `forgetNode`. */
  forgetErrands(node: string): void;
}

interface Row {
  id: string;
  session: string | null;
  seq: number | null;
  project: string | null;
  title: string;
  body: string;
  state: ErrandState;
  left_by: 'quest' | 'you';
  created: number;
  updated: number;
  closed: number | null;
  patrol: string | null;
}

const COLUMNS = `id, session, seq, project, title, body, state, left_by, created, updated, closed,
  (SELECT json_extract(payload, '$.patrol.patrol') FROM events
     WHERE session = errands.session AND type = 'session.started' ORDER BY seq LIMIT 1) AS patrol`;

function toErrand(row: Row): Errand {
  return {
    id: row.id,
    ...(row.session === null ? {} : { session: row.session }),
    ...(row.seq === null ? {} : { seq: row.seq }),
    ...(row.project === null ? {} : { project: row.project }),
    title: row.title,
    body: row.body,
    state: row.state,
    by: row.left_by,
    created: row.created,
    updated: row.updated,
    ...(row.closed === null ? {} : { closed: row.closed }),
    ...(row.patrol === null ? {} : { patrol: row.patrol }),
  };
}

export function openErrands(db: Database.Database): Errands {
  const insertLeft = db.prepare(
    `INSERT OR IGNORE INTO errands (node, id, session, seq, project, title, body, state, left_by, created, updated, closed)
     VALUES (@node, @id, @session, @seq, @project, @title, @body, 'open', 'quest', @ts, @ts, NULL)`,
  );
  const insertHand = db.prepare(
    `INSERT INTO errands (node, id, session, seq, project, title, body, state, left_by, created, updated, closed)
     VALUES (@node, @id, NULL, NULL, @project, @title, @body, 'open', 'you', @now, @now, NULL)`,
  );
  const list = db.prepare(`SELECT ${COLUMNS} FROM errands WHERE node = ? ORDER BY created DESC, id`);
  const one = db.prepare(`SELECT ${COLUMNS} FROM errands WHERE node = ? AND id = ?`);
  const counts = db.prepare(`SELECT node, COUNT(*) AS n FROM errands WHERE state = 'open' GROUP BY node`);
  const edit = db.prepare(
    `UPDATE errands SET title = @title, body = @body, updated = @now WHERE node = @node AND id = @id`,
  );
  const setState = db.prepare(
    `UPDATE errands SET state = @state, updated = @now, closed = CASE WHEN @state = 'open' THEN NULL ELSE @now END
     WHERE node = @node AND id = @id`,
  );
  const dueNodes = db.prepare(`SELECT DISTINCT node FROM errands WHERE state != 'open' AND closed <= ?`);
  const purge = db.prepare(`DELETE FROM errands WHERE state != 'open' AND closed <= ?`);
  const forget = db.prepare(`DELETE FROM errands WHERE node = ?`);

  const get = (node: string, id: string): Errand | undefined => {
    const row = one.get(node, id) as Row | undefined;
    return row && toErrand(row);
  };
  const purgeTxn = db.transaction((cutoff: number): string[] => {
    const nodes = (dueNodes.all(cutoff) as { node: string }[]).map((row) => row.node);
    purge.run(cutoff);
    return nodes;
  });

  return {
    recordErrandLeft(left) {
      insertLeft.run({ ...left, project: left.project ?? null });
    },
    errands: (node) => (list.all(node) as Row[]).map(toErrand),
    openErrandCounts() {
      const out: Record<string, number> = {};
      for (const row of counts.all() as { node: string; n: number }[]) out[row.node] = row.n;
      return out;
    },
    addErrand(node, errand, now) {
      const id = randomUUID();
      insertHand.run({ node, id, project: errand.project ?? null, title: errand.title, body: errand.body, now });
      return get(node, id) as Errand;
    },
    editErrand(node, id, change, now) {
      if (edit.run({ node, id, title: change.title, body: change.body, now }).changes === 0) return undefined;
      return get(node, id);
    },
    setErrandState(node, id, state, now) {
      if (setState.run({ node, id, state, now }).changes === 0) return undefined;
      return get(node, id);
    },
    purgeErrands: (now) => purgeTxn(now - ERRANDS_KEPT_MS),
    forgetErrands(node) {
      forget.run(node);
    },
  };
}
