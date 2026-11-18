import type Database from 'better-sqlite3';
import type {
  Board,
  BoardItem,
  BoardItemsChange,
  BoardItemState,
  ListedScout,
  Scout,
  ScoutItem,
  ScoutRun,
} from '@crystal-bridge/protocol';

/** How many runs the hub keeps per Scout. */
export const SCOUT_RUNS_KEPT = 50;
/** How many of those a Board shows. */
export const SCOUT_RUNS_SHOWN = 20;
/** How long an item the collector stopped listing stays on record, for the Board's history and in case it returns. */
export const GONE_ITEMS_KEPT_MS = 14 * 24 * 60 * 60 * 1000;

/** The store's Scouts and Boards (docs/SCOUTS.md), on the store's own database. */
export interface Boards {
  /** Replaces a Kingdom's list of Scouts. Items and runs of a Scout taken off the list stay, in case it comes back. */
  putScouts(node: string, scouts: readonly Scout[]): void;
  /** A Kingdom's Scouts in its order, each with how many of its items are new and its latest run. */
  scouts(node: string, now: number): ListedScout[];
  /**
   * Records a run; one that succeeded brings its full list, which is compared with the last. Returns the Board as it now
   * stands, or undefined for a run already recorded, which a Kingdom resends after reconnecting.
   */
  recordScoutRun(
    node: string,
    scout: string,
    run: ScoutRun,
    items: readonly ScoutItem[] | undefined,
    now: number,
  ): Board | undefined;
  /** Whether a Kingdom lists this Scout. */
  hasScout(node: string, scout: string): boolean;
  /** A Scout's Board, or undefined when its Kingdom doesn't list that Scout. */
  board(node: string, scout: string, now: number): Board | undefined;
  /** Changes items' state, as the user asked, and returns the items that changed. Ids not on the Board are skipped. */
  changeBoardItems(node: string, scout: string, change: BoardItemsChange, now: number): BoardItem[];
  /** Deletes everything held for a Kingdom; part of the store's `forgetNode`. */
  forgetBoards(node: string): void;
}

interface ItemRow {
  id: string;
  rev: string;
  state: BoardItemState;
  until: number | null;
  first_seen: number;
  changed_at: number;
  gone_at: number | null;
  data: string;
}

/** Where an item stands now: a snooze that has run out reads as new. */
function current(row: ItemRow, now: number): { state: BoardItemState; until?: number } {
  if (row.state === 'snoozed' && row.until !== null && row.until > now) return { state: 'snoozed', until: row.until };
  return { state: row.state === 'snoozed' ? 'new' : row.state };
}

function boardItem(row: ItemRow, now: number): BoardItem {
  const item = JSON.parse(row.data) as ScoutItem;
  return {
    ...item,
    ...current(row, now),
    firstSeen: row.first_seen,
    changedAt: row.changed_at,
    ...(row.gone_at === null ? {} : { goneAt: row.gone_at }),
  };
}

export function openBoards(db: Database.Database): Boards {
  const deleteScouts = db.prepare(`DELETE FROM scouts WHERE node = ?`);
  const insertScout = db.prepare(`INSERT INTO scouts (node, id, ord, data) VALUES (?, ?, ?, ?)`);
  const listScouts = db.prepare(`SELECT data FROM scouts WHERE node = ? ORDER BY ord`);
  const hasScout = db.prepare(`SELECT 1 FROM scouts WHERE node = ? AND id = ?`);
  const fresh = db.prepare(
    `SELECT count(*) AS n FROM scout_items WHERE node = @node AND scout = @scout AND gone_at IS NULL
       AND (state = 'new' OR (state = 'snoozed' AND until <= @now))`,
  );
  const runExists = db.prepare(`SELECT 1 FROM scout_runs WHERE node = ? AND id = ?`);
  const insertRun = db.prepare(
    `INSERT INTO scout_runs (node, id, scout, started_at, outcome, data) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const newerList = db.prepare(
    `SELECT 1 FROM scout_runs WHERE node = ? AND scout = ? AND outcome = 'succeeded' AND started_at > ? LIMIT 1`,
  );
  const latestRuns = db.prepare(
    `SELECT data FROM scout_runs WHERE node = ? AND scout = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`,
  );
  const pruneRuns = db.prepare(
    `DELETE FROM scout_runs WHERE node = @node AND scout = @scout AND id NOT IN
       (SELECT id FROM scout_runs WHERE node = @node AND scout = @scout ORDER BY started_at DESC, rowid DESC LIMIT @keep)`,
  );
  const items = db.prepare(
    `SELECT id, rev, state, until, first_seen, changed_at, gone_at, data FROM scout_items
     WHERE node = ? AND scout = ? ORDER BY gone_at IS NOT NULL, gone_at DESC, ord`,
  );
  const insertItem = db.prepare(
    `INSERT INTO scout_items (node, scout, id, ord, rev, state, first_seen, changed_at, data)
     VALUES (@node, @scout, @id, @ord, @rev, 'new', @now, @now, @data)`,
  );
  const changedItem = db.prepare(
    `UPDATE scout_items SET ord = @ord, rev = @rev, state = 'new', until = NULL, changed_at = @now, gone_at = NULL,
       data = @data WHERE node = @node AND scout = @scout AND id = @id`,
  );
  const sameItem = db.prepare(
    `UPDATE scout_items SET ord = @ord, gone_at = NULL, data = @data WHERE node = @node AND scout = @scout AND id = @id`,
  );
  const goneItem = db.prepare(`UPDATE scout_items SET gone_at = ? WHERE node = ? AND scout = ? AND id = ?`);
  const pruneGone = db.prepare(`DELETE FROM scout_items WHERE node = ? AND scout = ? AND gone_at < ?`);
  const getItem = db.prepare(
    `SELECT id, rev, state, until, first_seen, changed_at, gone_at, data FROM scout_items
     WHERE node = ? AND scout = ? AND id = ?`,
  );
  const setState = db.prepare(`UPDATE scout_items SET state = ?, until = ? WHERE node = ? AND scout = ? AND id = ?`);
  const forgetScouts = db.prepare(`DELETE FROM scouts WHERE node = ?`);
  const forgetRuns = db.prepare(`DELETE FROM scout_runs WHERE node = ?`);
  const forgetItems = db.prepare(`DELETE FROM scout_items WHERE node = ?`);

  const runsOf = (node: string, scout: string, limit: number) =>
    (latestRuns.all(node, scout, limit) as { data: string }[]).map((row) => JSON.parse(row.data) as ScoutRun);

  const boardOf = (node: string, scout: string, now: number): Board => ({
    scout,
    runs: runsOf(node, scout, SCOUT_RUNS_SHOWN),
    items: (items.all(node, scout) as ItemRow[]).map((row) => boardItem(row, now)),
  });

  const putScouts = db.transaction((node: string, scouts: readonly Scout[]) => {
    deleteScouts.run(node);
    scouts.forEach((scout, ord) => insertScout.run(node, scout.id, ord, JSON.stringify(scout)));
  });

  const record = db.transaction(
    (node: string, scout: string, run: ScoutRun, list: readonly ScoutItem[] | undefined, now: number) => {
      if (runExists.get(node, run.id)) return undefined;
      // A list older than one already taken, such as a late resend, would undo newer changes and what you did since.
      const stale = list !== undefined && newerList.get(node, scout, run.startedAt) !== undefined;
      insertRun.run(node, run.id, scout, run.startedAt, run.outcome, JSON.stringify(run));
      pruneRuns.run({ node, scout, keep: SCOUT_RUNS_KEPT });
      if (list && !stale) {
        const known = new Map((items.all(node, scout) as ItemRow[]).map((row) => [row.id, row]));
        list.forEach((item, ord) => {
          const row = known.get(item.id);
          known.delete(item.id);
          const values = { node, scout, id: item.id, ord, rev: item.rev ?? '', now, data: JSON.stringify(item) };
          if (!row) insertItem.run(values);
          else if (row.rev !== values.rev) changedItem.run(values);
          else sameItem.run(values);
        });
        for (const row of known.values()) if (row.gone_at === null) goneItem.run(now, node, scout, row.id);
      }
      pruneGone.run(node, scout, now - GONE_ITEMS_KEPT_MS);
      return boardOf(node, scout, now);
    },
  );

  const change = db.transaction((node: string, scout: string, wanted: BoardItemsChange, now: number) => {
    const changed: BoardItem[] = [];
    for (const id of new Set(wanted.ids)) {
      const row = getItem.get(node, scout, id) as ItemRow | undefined;
      if (!row) continue;
      const was = current(row, now);
      // Looking at an item never undoes what you did with it.
      if (wanted.state === 'seen' && was.state !== 'new') continue;
      const until = wanted.state === 'snoozed' ? (wanted.until ?? null) : null;
      if (row.state === wanted.state && row.until === until) continue;
      setState.run(wanted.state, until, node, scout, id);
      changed.push(boardItem({ ...row, state: wanted.state, until }, now));
    }
    return changed;
  });

  return {
    putScouts(node, scouts) {
      putScouts(node, scouts);
    },
    scouts(node, now) {
      return (listScouts.all(node) as { data: string }[]).map((row) => {
        const scout = JSON.parse(row.data) as Scout;
        const [lastRun] = runsOf(node, scout.id, 1);
        const count = (fresh.get({ node, scout: scout.id, now }) as { n: number }).n;
        return { ...scout, fresh: count, ...(lastRun ? { lastRun } : {}) };
      });
    },
    recordScoutRun(node, scout, run, list, now) {
      return record(node, scout, run, list, now);
    },
    hasScout(node, scout) {
      return hasScout.get(node, scout) !== undefined;
    },
    board(node, scout, now) {
      return hasScout.get(node, scout) ? boardOf(node, scout, now) : undefined;
    },
    changeBoardItems(node, scout, wanted, now) {
      return change(node, scout, wanted, now);
    },
    forgetBoards(node) {
      forgetScouts.run(node);
      forgetRuns.run(node);
      forgetItems.run(node);
    },
  };
}
