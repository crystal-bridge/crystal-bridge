import type Database from 'better-sqlite3';
import {
  DeedRecordedPayload,
  DeedsClosingPayload,
  PatrolRun,
  TurnTallyPayload,
  type Deed,
  type DeedKind,
  type Envelope,
} from '@crystal-bridge/protocol';
import { z } from 'zod';

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

/** What a `turn.finished` carries that a turn record keeps; a bad optional field is dropped, a bad outcome refuses it. */
export const TurnFinishedRecord = z.object({
  outcome: z.string().max(32),
  summary: z.string().optional().catch(undefined),
  costUsd: z.number().nonnegative().optional().catch(undefined),
  durationMs: z.number().int().nonnegative().optional().catch(undefined),
});

/** The id of the row an event made (or would make), or undefined for an event that makes none or can't be read. */
export function deedIdFor(event: Envelope): string | undefined {
  switch (event.type) {
    case 'turn.finished':
      return TurnFinishedRecord.safeParse(event.payload).success ? `turn:${event.session}:${event.seq}` : undefined;
    case 'turn.tally': {
      const tally = TurnTallyPayload.safeParse(event.payload).data;
      return tally && `turn:${event.session}:${tally.seq}`;
    }
    case 'deed.recorded': {
      const deed = DeedRecordedPayload.safeParse(event.payload).data;
      return deed && `deed:${deed.id}`;
    }
    case 'deeds.closing':
      return DeedsClosingPayload.safeParse(event.payload).success ? `close:${event.session}:${event.seq}` : undefined;
    default:
      return undefined;
  }
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
     VALUES (@id, @node, @session, @seq, @patrol, @project, @kind, @text, @detail, @outcome, @costUsd, @durationMs, NULL, NULL, @at)`,
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

  const blank = { patrol: null, text: null, detail: null, outcome: null, costUsd: null, durationMs: null };
  const write = (fields: Record<string, unknown>) => insert.run({ ...blank, ...fields });

  return {
    recordTurn({ node, session, seq, ts, project, patrol, payload }) {
      write({
        id: `turn:${session}:${seq}`,
        node,
        session,
        seq,
        project: project ?? null,
        patrol: patrol ?? null,
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

/** Turn records read per step of the backfill, so a long history isn't held in memory at once. */
const BACKFILL_STEP = 1000;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Fills turn records for the turns a hub held before Deeds, and rows for the script Patrol runs `patrol_runs` still
 * keeps (docs/DEEDS.md, History). It's code, not the migration's SQL, because a Quest's project comes from its
 * `session.started` by the path rule Errands use. It runs whenever `deeds` is empty rather than behind a marker: that
 * survives a hub stopped between the migration and this, and every later turn writes a row, so it never runs twice.
 * One transaction; a row that can't be read is skipped, so an old bad payload never stops the hub starting.
 */
export function backfillDeeds(
  db: Database.Database,
  deeds: Deeds,
  quest: { project(session: string): string | undefined; patrol(session: string): string | undefined },
): void {
  if (db.prepare('SELECT 1 FROM deeds LIMIT 1').get() !== undefined) return;
  // Through the (type, ts) index, a step at a time; the index carries the key (session, seq) to page by.
  const firstTurns = db.prepare(
    `SELECT session, seq, node, ts, payload FROM events WHERE type = 'turn.finished'
     ORDER BY ts, session, seq LIMIT ${BACKFILL_STEP}`,
  );
  const nextTurns = db.prepare(
    `SELECT session, seq, node, ts, payload FROM events WHERE type = 'turn.finished' AND (ts, session, seq) > (?, ?, ?)
     ORDER BY ts, session, seq LIMIT ${BACKFILL_STEP}`,
  );
  const runs = db.prepare('SELECT node, patrol, data FROM patrol_runs');
  type TurnRow = { session: string; seq: number; node: string; ts: number; payload: string };
  const quests = new Map<string, { project?: string; patrol?: string }>();
  const questOf = (session: string) => {
    let found = quests.get(session);
    if (!found) {
      found = {};
      try {
        found = { project: quest.project(session), patrol: quest.patrol(session) };
      } catch {
        // An unreadable session.started leaves its turns without a project, as a live turn would be.
      }
      quests.set(session, found);
    }
    return found;
  };

  db.transaction(() => {
    let rows = firstTurns.all() as TurnRow[];
    while (rows.length > 0) {
      for (const row of rows) {
        const turn = TurnFinishedRecord.safeParse(parseJson(row.payload)).data;
        if (!turn) continue;
        const { project, patrol } = questOf(row.session);
        deeds.recordTurn({
          node: row.node,
          session: row.session,
          seq: row.seq,
          ts: row.ts,
          project,
          patrol,
          payload: turn,
        });
      }
      if (rows.length < BACKFILL_STEP) break;
      const last = rows[rows.length - 1]!;
      rows = nextTurns.all(last.ts, last.session, last.seq) as TurnRow[];
    }
    for (const row of runs.all() as { node: string; patrol: string; data: string }[]) {
      const run = PatrolRun.safeParse(parseJson(row.data)).data;
      if (run) deeds.recordScriptRun(row.node, row.patrol, run);
    }
  })();
}
