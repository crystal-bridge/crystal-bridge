import type Database from 'better-sqlite3';
import type { ListedPatrol, Patrol, PatrolRun } from '@crystal-bridge/protocol';

/** How many runs the hub keeps per Patrol. */
export const PATROL_RUNS_KEPT = 50;
/** How many of those a Patrol's history shows. */
export const PATROL_RUNS_SHOWN = 20;

/** The store's Patrols (docs/PATROLS.md), on the store's own database. */
export interface Patrols {
  /** Replaces a Kingdom's list of Patrols. Runs of a Patrol taken off the list stay, in case it comes back. */
  putPatrols(node: string, patrols: readonly Patrol[]): void;
  /** A Kingdom's Patrols in its order, each with its latest run. */
  patrols(node: string): ListedPatrol[];
  /** Whether a Kingdom lists this Patrol. */
  hasPatrol(node: string, patrol: string): boolean;
  /**
   * Records a run, or updates it when the Kingdom reports it again (back from its round, or resent after a reconnect).
   * Returns the Patrol's recent runs as they now stand.
   */
  recordPatrolRun(node: string, patrol: string, run: PatrolRun): PatrolRun[];
  /** A Patrol's recent runs, newest first, or undefined when its Kingdom doesn't list that Patrol. */
  patrolRuns(node: string, patrol: string, limit?: number): PatrolRun[] | undefined;
  /** Deletes everything held for a Kingdom; part of the store's `forgetNode`. */
  forgetPatrols(node: string): void;
}

export function openPatrols(db: Database.Database): Patrols {
  const deletePatrols = db.prepare(`DELETE FROM patrols WHERE node = ?`);
  const insertPatrol = db.prepare(`INSERT INTO patrols (node, id, ord, data) VALUES (?, ?, ?, ?)`);
  const listPatrols = db.prepare(`SELECT data FROM patrols WHERE node = ? ORDER BY ord`);
  const hasPatrol = db.prepare(`SELECT 1 FROM patrols WHERE node = ? AND id = ?`);
  // A run keeps the Patrol it was first reported under: a later report can't move it to another.
  const upsertRun = db.prepare(
    `INSERT INTO patrol_runs (node, id, patrol, started_at, outcome, data) VALUES (@node, @id, @patrol, @startedAt, @outcome, @data)
     ON CONFLICT (node, id) DO UPDATE SET started_at = excluded.started_at, outcome = excluded.outcome,
       data = excluded.data WHERE patrol_runs.patrol = excluded.patrol`,
  );
  const latestRuns = db.prepare(
    `SELECT data FROM patrol_runs WHERE node = ? AND patrol = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`,
  );
  const pruneRuns = db.prepare(
    `DELETE FROM patrol_runs WHERE node = @node AND patrol = @patrol AND id NOT IN
       (SELECT id FROM patrol_runs WHERE node = @node AND patrol = @patrol ORDER BY started_at DESC, rowid DESC LIMIT @keep)`,
  );
  const forgetPatrols = db.prepare(`DELETE FROM patrols WHERE node = ?`);
  const forgetRuns = db.prepare(`DELETE FROM patrol_runs WHERE node = ?`);

  const runsOf = (node: string, patrol: string, limit: number) =>
    (latestRuns.all(node, patrol, limit) as { data: string }[]).map((row) => JSON.parse(row.data) as PatrolRun);

  const put = db.transaction((node: string, patrols: readonly Patrol[]) => {
    deletePatrols.run(node);
    patrols.forEach((patrol, ord) => insertPatrol.run(node, patrol.id, ord, JSON.stringify(patrol)));
  });

  const record = db.transaction((node: string, patrol: string, run: PatrolRun) => {
    upsertRun.run({
      node,
      id: run.id,
      patrol,
      startedAt: run.startedAt,
      outcome: run.outcome,
      data: JSON.stringify(run),
    });
    pruneRuns.run({ node, patrol, keep: PATROL_RUNS_KEPT });
    return runsOf(node, patrol, PATROL_RUNS_SHOWN);
  });

  return {
    putPatrols(node, patrols) {
      put(node, patrols);
    },
    patrols(node) {
      return (listPatrols.all(node) as { data: string }[]).map((row) => {
        const patrol = JSON.parse(row.data) as Patrol;
        const [lastRun] = runsOf(node, patrol.id, 1);
        return { ...patrol, ...(lastRun ? { lastRun } : {}) };
      });
    },
    hasPatrol(node, patrol) {
      return hasPatrol.get(node, patrol) !== undefined;
    },
    recordPatrolRun(node, patrol, run) {
      return record(node, patrol, run);
    },
    patrolRuns(node, patrol, limit = PATROL_RUNS_SHOWN) {
      return hasPatrol.get(node, patrol) ? runsOf(node, patrol, limit) : undefined;
    },
    forgetPatrols(node) {
      forgetPatrols.run(node);
      forgetRuns.run(node);
    },
  };
}
