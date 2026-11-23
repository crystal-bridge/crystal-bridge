import type Database from 'better-sqlite3';
import type {
  Deed,
  DeedKind,
  DeedRecordedPayload,
  DeedsClosingPayload,
  PatrolRun,
  TurnTallyPayload,
} from '@crystal-bridge/protocol';

/** Rows in one page of the feed, at most. */
export const DEEDS_PAGE_ROWS = 5000;

/** Where an event came from: the Kingdom, the Quest, its place in the Quest's events and its project. */
export interface QuestEvent {
  node: string;
  session: string;
  seq: number;
  ts: number;
  project?: string;
  patrol?: string;
}

/** The store's Deeds (docs/DEEDS.md), on the store's own database. */
export interface Deeds {
  /** A turn record from a stored `turn.finished`. Part of `appendEvent`'s transaction. */
  recordTurn(
    turn: QuestEvent & { payload: { outcome: string; summary?: string; costUsd?: number; durationMs?: number } },
  ): void;
  /** Fills a turn record's counts from its `turn.tally`. */
  recordTally(tally: { node: string; session: string } & TurnTallyPayload): void;
  recordDeed(deed: QuestEvent & DeedRecordedPayload): void;
  recordClose(close: QuestEvent & DeedsClosingPayload): void;
  /** A script Patrol's run, once it's back finished or failed; upserted, since a run is reported out, then back. */
  recordScriptRun(node: string, patrol: string, run: PatrolRun): void;
  /** Rows with after <= at < before, newest first, and the time of the newest row before `after`. */
  deedsPage(node: string, page: { after: number; before: number; project?: string }): { deeds: Deed[]; older?: number };
  deed(id: string): Deed | undefined;
  /** Part of the store's `forgetNode`. */
  forgetDeeds(node: string): void;
}

interface Row {
  id: string;
  session: string | null;
  seq: number | null;
  patrol: string | null;
  project: string | null;
  kind: DeedKind;
  text: string | null;
  detail: string | null;
  outcome: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  files: number | null;
  prs: string | null;
  at: number;
}

const COLUMNS = `id, session, seq, patrol, project, kind, text, detail, outcome, cost_usd, duration_ms, files, prs, at`;

function toDeed(row: Row): Deed {
  return {
    id: row.id,
    ...(row.session === null ? {} : { session: row.session }),
    ...(row.seq === null ? {} : { seq: row.seq }),
    ...(row.patrol === null ? {} : { patrol: row.patrol }),
    ...(row.project === null ? {} : { project: row.project }),
    kind: row.kind,
    ...(row.text === null ? {} : { text: row.text }),
    ...(row.detail === null ? {} : { detail: row.detail }),
    ...(row.outcome === null ? {} : { outcome: row.outcome }),
    ...(row.cost_usd === null ? {} : { costUsd: row.cost_usd }),
    ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
    ...(row.files === null ? {} : { files: row.files }),
    ...(row.prs === null ? {} : { prs: JSON.parse(row.prs) as string[] }),
    at: row.at,
  };
}

export function openDeeds(db: Database.Database): Deeds {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO deeds (id, node, session, seq, patrol, project, kind, text, detail, outcome, cost_usd, duration_ms, files, prs, at)
     VALUES (@id, @node, @session, @seq, NULL, @project, @kind, @text, @detail, @outcome, @costUsd, @durationMs, NULL, NULL, @at)`,
  );
  const upsertRun = db.prepare(
    `INSERT INTO deeds (id, node, session, seq, patrol, project, kind, text, detail, outcome, cost_usd, duration_ms, files, prs, at)
     VALUES (@id, @node, NULL, NULL, @patrol, NULL, 'patrol', @text, NULL, @outcome, NULL, @durationMs, NULL, NULL, @at)
     ON CONFLICT (id) DO UPDATE SET text = excluded.text, outcome = excluded.outcome,
       duration_ms = excluded.duration_ms, at = excluded.at`,
  );
  const tally = db.prepare(
    `UPDATE deeds SET files = @files, prs = @prs WHERE id = @id AND node = @node AND kind = 'turn'`,
  );
  const pageAll = db.prepare(
    `SELECT ${COLUMNS} FROM deeds WHERE node = @node AND at >= @after AND at < @before
     ORDER BY at DESC, id LIMIT ${DEEDS_PAGE_ROWS}`,
  );
  const pageProject = db.prepare(
    `SELECT ${COLUMNS} FROM deeds WHERE node = @node AND project = @project AND at >= @after AND at < @before
     ORDER BY at DESC, id LIMIT ${DEEDS_PAGE_ROWS}`,
  );
  const olderAll = db.prepare(`SELECT MAX(at) FROM deeds WHERE node = @node AND at < @after`).pluck();
  const olderProject = db
    .prepare(`SELECT MAX(at) FROM deeds WHERE node = @node AND project = @project AND at < @after`)
    .pluck();
  const one = db.prepare(`SELECT ${COLUMNS} FROM deeds WHERE id = ?`);
  const forget = db.prepare(`DELETE FROM deeds WHERE node = ?`);

  const blank = { text: null, detail: null, outcome: null, costUsd: null, durationMs: null };
  const write = (fields: Record<string, unknown>) => insert.run({ ...blank, ...fields });

  return {
    recordTurn({ node, session, seq, ts, project, payload }) {
      write({
        id: `turn:${session}:${seq}`,
        node,
        session,
        seq,
        project: project ?? null,
        kind: 'turn',
        text: payload.outcome === 'success' ? (payload.summary ?? null) : null,
        outcome: payload.outcome,
        costUsd: payload.costUsd ?? null,
        durationMs: payload.durationMs ?? null,
        at: ts,
      });
    },
    recordTally({ node, session, seq, files, prs }) {
      tally.run({ id: `turn:${session}:${seq}`, node, files, prs: JSON.stringify(prs) });
    },
    recordDeed({ node, session, seq, ts, project, id, deed, detail, closing }) {
      write({
        id: `deed:${id}`,
        node,
        session,
        seq,
        project: project ?? null,
        kind: closing ? 'closing' : 'deed',
        text: deed,
        detail: detail ?? null,
        at: ts,
      });
    },
    recordClose({ node, session, seq, ts, project, outcome, costUsd, reason }) {
      write({
        id: `close:${session}:${seq}`,
        node,
        session,
        seq,
        project: project ?? null,
        kind: 'close',
        text: reason ?? null,
        outcome,
        costUsd: costUsd ?? null,
        at: ts,
      });
    },
    recordScriptRun(node, patrol, run) {
      if (run.session !== undefined || (run.outcome !== 'finished' && run.outcome !== 'failed')) return;
      upsertRun.run({
        id: `run:${run.id}`,
        node,
        patrol,
        text: run.summary ?? null,
        outcome: run.outcome,
        durationMs: run.finishedAt === undefined ? null : run.finishedAt - run.startedAt,
        at: run.finishedAt ?? run.startedAt,
      });
    },
    deedsPage(node, { after, before, project }) {
      const args = { node, after, before, ...(project === undefined ? {} : { project }) };
      const rows = (project === undefined ? pageAll : pageProject).all(args) as Row[];
      const older = (project === undefined ? olderAll : olderProject).get(args) as number | null;
      return { deeds: rows.map(toDeed), ...(older === null ? {} : { older }) };
    },
    deed(id) {
      const row = one.get(id) as Row | undefined;
      return row && toDeed(row);
    },
    forgetDeeds(node) {
      forget.run(node);
    },
  };
}
