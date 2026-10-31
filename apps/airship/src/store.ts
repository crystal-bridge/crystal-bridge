import Database from 'better-sqlite3';
import { migrate } from './migrations.js';
import { z } from 'zod';
import {
  Appearance,
  Effort,
  Engine,
  type Envelope,
  PushPrefs,
  PushSubscriptionJson,
  UsagePayload,
} from '@crystal-bridge/protocol';

export type SessionStatus = 'running' | 'idle' | 'ended' | 'closed';

export interface SessionRow {
  id: string;
  node: string;
  cwd: string;
  label: string;
  status: SessionStatus;
  createdAt: number;
}

/** A session as listed: its row plus the time of its latest event, for telling recent work from old. */
export interface ListedSession extends SessionRow {
  lastActivity: number;
  /** Bytes the hub has sent clients about this session, all devices together (flushed counts only). */
  relayedBytes: number;
  /** The start of its latest finished turn's reply, when there is one. */
  preview?: string;
}

/** A node's finished turns since a time, from the engine-neutral `turn.finished` payloads. */
export interface TurnStats {
  node: string;
  turns: number;
  /** Turns that ended in an error. */
  kos: number;
  costUsd: number;
  durationMs: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** A Quest's lifetime battles, for the client's pointless levels (#23): engine-neutral, from turn.finished. */
export interface QuestXp {
  session: string;
  node: string;
  /** Turns that ended in success. */
  won: number;
  /** Turns that ended in an error. */
  kos: number;
  /** The Quest was closed (completed). */
  completed: boolean;
}

/** One line of the activity feed: a Quest started or closed, or one of its turns finished. */
export interface ActivityItem {
  session: string;
  node: string;
  label: string;
  ts: number;
  kind: 'started' | 'closed' | 'turn';
  /** For a finished turn: success, error or interrupted. */
  outcome?: string;
}

/** A search hit: the matching event, with its session's label. */
export interface SearchHit {
  session: string;
  seq: number;
  label: string;
  event: Envelope;
}

/** The latest `usage` a node reported, with the envelope's timestamp. */
export interface NodeUsage extends UsagePayload {
  node: string;
  ts: number;
}

export interface Store {
  appendEvent(event: Envelope): boolean;
  eventsSince(session: string, seq: number): Envelope[];
  listSessions(): ListedSession[];
  /** Finished turns since `since` (epoch ms), per node, ordered by node id. */
  turnStats(since: number): TurnStats[];
  /** Every Quest's lifetime battles, for levels. */
  questXp(): QuestXp[];
  /** The newest Quest starts, closes and finished turns across all nodes. */
  activity(limit: number): ActivityItem[];
  /** Quests with a permission request nobody has answered, and that can still be answered. */
  waiting(): { session: string; node: string }[];
  /** Adds bytes relayed to clients, per session, in one transaction. */
  addRelayed(bytes: ReadonlyMap<string, number>): void;
  /** Deletes everything held for a node, in one transaction, and returns the ids of the sessions that went. */
  forgetNode(node: string): string[];
  /** One more than the highest stored seq of a session, or 0 when it has none. */
  nextSeq(session: string): number;
  /**
   * Marks a node's `running` sessions `idle` unless the node still holds them, for a node that
   * restarted while they ran: their process is gone, but a send resumes them. Returns the ids changed.
   */
  releaseOrphans(node: string, held: readonly string[]): string[];
  /**
   * The newest events of one node whose payload contains `query` (case-insensitive for ASCII), among the kinds a
   * person reads: session starts, follow-ups and engine events. Deciding which engine events matter is the client's.
   */
  search(node: string, query: string, limit: number): SearchHit[];
  /** The newest usage report from each node, ordered by node id. */
  latestUsage(): NodeUsage[];
  getSession(id: string): SessionRow | undefined;
  /** The engine a session started on, from its session.started payload; undefined for the default or unknown. */
  sessionEngine(id: string): Engine | undefined;
  /** The effort a session started with, read from its session.started; undefined when unset. */
  sessionEffort(id: string): Effort | undefined;
  /** Adds a device's Web Push subscription, or replaces its keys and prefs. */
  putPushSubscription(subscription: PushSubscriptionJson, prefs: PushPrefs): void;
  /** Removes a subscription; false when there was none. */
  deletePushSubscription(endpoint: string): boolean;
  /** Every stored subscription, oldest first; rows that no longer parse are skipped. */
  listPushSubscriptions(): { subscription: PushSubscriptionJson; prefs: PushPrefs }[];
  /** A user's Kingdom appearance, keyed by tailnet login; undefined until they set one. */
  getAppearance(login: string): Appearance | undefined;
  /** Replaces a user's appearance (last write wins). */
  putAppearance(login: string, appearance: Appearance): void;
  close(): void;
}

// payload shape documented on EventType 'session.started' in @crystal-bridge/protocol
const SessionStartedPayload = z.object({
  cwd: z.string(),
  prompt: z.string(),
  label: z.string(),
  /** Taken over from outside the bridge: nothing runs until the first follow-up. */
  adopted: z.boolean().optional(),
});

// payload shape documented on EventType 'session.ended'; older events have no reason
const SessionEndedPayload = z.object({ reason: z.enum(['idle', 'exit', 'error']).optional() });

interface EventTableRow {
  session: string;
  seq: number;
  node: string;
  ts: number;
  type: string;
  payload: string;
}

interface SessionTableRow {
  id: string;
  node: string;
  cwd: string;
  label: string;
  status: string;
  created_at: number;
}

export function openStore(path: string): Store {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');

  migrate(db);

  const insertEventStmt = db.prepare(
    `INSERT INTO events (session, seq, node, ts, type, payload) VALUES (@session, @seq, @node, @ts, @type, @payload)
     ON CONFLICT DO NOTHING`,
  );
  const insertSessionStmt = db.prepare(
    `INSERT INTO sessions (id, node, cwd, label, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const waitingStmt = db.prepare(`
    SELECT DISTINCT asked.session AS session, asked.node AS node
      FROM events asked
     WHERE asked.type = 'permission.request'
       AND NOT EXISTS (
         SELECT 1 FROM events later
          WHERE later.session = asked.session AND later.seq > asked.seq
            AND (later.type IN ('session.ended', 'session.closed')
              OR (later.type = 'permission.resolved'
                  AND json_extract(later.payload, '$.requestId') = json_extract(asked.payload, '$.requestId'))))
    UNION
    SELECT asked.session, asked.node
      FROM events asked
     WHERE asked.type = 'terminal.screen'
       AND json_extract(asked.payload, '$.raised') = 1
       AND NOT EXISTS (
         SELECT 1 FROM events later
          WHERE later.session = asked.session AND later.seq > asked.seq
            AND (later.type IN ('session.ended', 'session.closed')
              OR (later.type = 'terminal.screen' AND json_extract(later.payload, '$.open') = 0)))`);
  const setStatusStmt = db.prepare(`UPDATE sessions SET status = ? WHERE id = ?`);
  // A closed Quest is done for good: its process ending (or a stray resume) arrives after the close and mustn't reopen it.
  const setOpenStatusStmt = db.prepare(`UPDATE sessions SET status = ? WHERE id = ? AND status != 'closed'`);
  const eventsSinceStmt = db.prepare(
    `SELECT session, seq, node, ts, type, payload FROM events WHERE session = ? AND seq >= ? ORDER BY seq ASC`,
  );
  const listSessionsStmt = db.prepare(
    // The latest event is the highest seq; the events primary key makes that lookup one index probe per session.
    `SELECT id, node, cwd, label, status, created_at,
       COALESCE((SELECT ts FROM events WHERE session = sessions.id ORDER BY seq DESC LIMIT 1), created_at) AS last_activity,
       COALESCE((SELECT bytes FROM relay WHERE session = sessions.id), 0) AS relayed_bytes,
       (SELECT json_extract(payload, '$.summary') FROM events
          WHERE session = sessions.id AND type = 'turn.finished' ORDER BY seq DESC LIMIT 1) AS preview
     FROM sessions ORDER BY created_at DESC`,
  );
  // Engine-neutral: these read only turn.finished payloads, which every engine's node fills in the same shape.
  const turnStatsStmt = db.prepare(
    `SELECT node, COUNT(*) AS turns,
       SUM(json_extract(payload, '$.outcome') = 'error') AS kos,
       TOTAL(json_extract(payload, '$.costUsd')) AS cost,
       TOTAL(json_extract(payload, '$.durationMs')) AS duration,
       TOTAL(json_extract(payload, '$.tokens.input')) AS input,
       TOTAL(json_extract(payload, '$.tokens.output')) AS output,
       TOTAL(json_extract(payload, '$.tokens.cacheRead')) AS cache_read,
       TOTAL(json_extract(payload, '$.tokens.cacheWrite')) AS cache_write
     FROM events WHERE type = 'turn.finished' AND ts >= ? GROUP BY node ORDER BY node`,
  );
  const questXpStmt = db.prepare(
    `SELECT s.id AS session, s.node AS node,
       (SELECT COUNT(*) FROM events WHERE session = s.id AND type = 'turn.finished'
          AND json_extract(payload, '$.outcome') = 'success') AS won,
       (SELECT COUNT(*) FROM events WHERE session = s.id AND type = 'turn.finished'
          AND json_extract(payload, '$.outcome') = 'error') AS kos,
       EXISTS (SELECT 1 FROM events WHERE session = s.id AND type = 'session.closed') AS completed
     FROM sessions s`,
  );
  const activityStmt = db.prepare(
    `SELECT e.session, e.node, s.label, e.ts, e.type, json_extract(e.payload, '$.outcome') AS outcome
     FROM events e JOIN sessions s ON s.id = e.session
     WHERE e.type IN ('session.started', 'session.closed', 'turn.finished')
     ORDER BY e.ts DESC LIMIT ?`,
  );
  const addRelayedStmt = db.prepare(
    `INSERT INTO relay (session, bytes) VALUES (?, ?) ON CONFLICT(session) DO UPDATE SET bytes = bytes + excluded.bytes`,
  );
  const addRelayedAll = db.transaction((bytes: ReadonlyMap<string, number>) => {
    for (const [session, n] of bytes) if (n > 0) addRelayedStmt.run(session, n);
  });
  const nodeSessionsStmt = db.prepare(`SELECT id FROM sessions WHERE node = ?`);
  const forgetRelayStmt = db.prepare(`DELETE FROM relay WHERE session IN (SELECT id FROM sessions WHERE node = ?)`);
  const forgetEventsStmt = db.prepare(`DELETE FROM events WHERE node = ?`);
  const forgetSessionsStmt = db.prepare(`DELETE FROM sessions WHERE node = ?`);
  const forgetNodeTxn = db.transaction((node: string): string[] => {
    const ids = (nodeSessionsStmt.all(node) as { id: string }[]).map((row) => row.id);
    forgetRelayStmt.run(node);
    forgetEventsStmt.run(node);
    forgetSessionsStmt.run(node);
    return ids;
  });
  const startedPayloadStmt = db.prepare(
    `SELECT payload FROM events WHERE session = ? AND type = 'session.started' ORDER BY seq LIMIT 1`,
  );
  const getSessionStmt = db.prepare(`SELECT id, node, cwd, label, status, created_at FROM sessions WHERE id = ?`);

  const maxSeqStmt = db.prepare(`SELECT MAX(seq) AS seq FROM events WHERE session = ?`);
  const searchStmt = db.prepare(
    `SELECT e.session, e.seq, e.node, e.ts, e.type, e.payload, s.label FROM events e JOIN sessions s ON s.id = e.session
     WHERE e.node = ? AND e.type IN ('session.started', 'user.message', 'claude.event') AND e.payload LIKE ? ESCAPE '\\'
     ORDER BY e.ts DESC, e.seq DESC LIMIT ?`,
  );
  const putPushStmt = db.prepare(
    `INSERT INTO push_subscriptions (endpoint, keys, prefs, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET keys = excluded.keys, prefs = excluded.prefs, updated_at = excluded.updated_at`,
  );
  const deletePushStmt = db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`);
  const listPushStmt = db.prepare(`SELECT endpoint, keys, prefs FROM push_subscriptions ORDER BY rowid`);
  const getAppearanceStmt = db.prepare(`SELECT data FROM appearance WHERE login = ?`);
  const putAppearanceStmt = db.prepare(
    `INSERT INTO appearance (login, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (login) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  );
  const runningOnNodeStmt = db.prepare(`SELECT id FROM sessions WHERE node = ? AND status = 'running'`);

  // Kept in memory, seeded from the events table: a usage report is one row like any other event.
  const usage = new Map<string, NodeUsage>();
  function noteUsage(node: string, ts: number, payload: unknown): void {
    const parsed = UsagePayload.safeParse(payload);
    if (!parsed.success) return;
    const current = usage.get(node);
    if (!current || ts >= current.ts) usage.set(node, { node, ts, ...parsed.data });
  }
  for (const row of db.prepare(`SELECT node, ts, payload FROM events WHERE type = 'usage'`).all() as EventTableRow[]) {
    noteUsage(row.node, row.ts, JSON.parse(row.payload));
  }

  const appendEventTxn = db.transaction((event: Envelope): boolean => {
    const result = insertEventStmt.run({
      session: event.session,
      seq: event.seq,
      node: event.node,
      ts: event.ts,
      type: event.type,
      payload: JSON.stringify(event.payload),
    });
    const inserted = result.changes === 1;
    if (!inserted) return false;

    if (event.type === 'session.started') {
      const payload = SessionStartedPayload.parse(event.payload);
      insertSessionStmt.run(
        event.session,
        event.node,
        payload.cwd,
        payload.label,
        payload.adopted ? 'idle' : 'running',
        event.ts,
      );
    } else if (event.type === 'session.ended') {
      const reason = SessionEndedPayload.safeParse(event.payload).data?.reason;
      setOpenStatusStmt.run(reason === 'idle' ? 'idle' : 'ended', event.session);
    } else if (event.type === 'session.resumed') {
      setOpenStatusStmt.run('running', event.session);
    } else if (event.type === 'session.closed') {
      setStatusStmt.run('closed', event.session);
    } else if (event.type === 'usage') {
      noteUsage(event.node, event.ts, event.payload);
    }
    return true;
  });

  function toEnvelope(row: EventTableRow): Envelope {
    return {
      node: row.node,
      session: row.session,
      seq: row.seq,
      ts: row.ts,
      type: row.type as Envelope['type'],
      payload: JSON.parse(row.payload),
    };
  }

  function toSessionRow(row: SessionTableRow): SessionRow {
    return {
      id: row.id,
      node: row.node,
      cwd: row.cwd,
      label: row.label,
      status: row.status as SessionStatus,
      createdAt: row.created_at,
    };
  }

  return {
    appendEvent(event) {
      return appendEventTxn(event);
    },
    eventsSince(session, seq) {
      return (eventsSinceStmt.all(session, seq) as EventTableRow[]).map(toEnvelope);
    },
    listSessions() {
      type Row = SessionTableRow & { last_activity: number; relayed_bytes: number; preview: unknown };
      return (listSessionsStmt.all() as Row[]).map((row) => ({
        ...toSessionRow(row),
        lastActivity: row.last_activity,
        relayedBytes: row.relayed_bytes,
        ...(typeof row.preview === 'string' && row.preview ? { preview: row.preview } : {}),
      }));
    },
    addRelayed(bytes) {
      addRelayedAll(bytes);
    },
    forgetNode(node) {
      const ids = forgetNodeTxn(node);
      usage.delete(node);
      return ids;
    },
    turnStats(since) {
      type Row = {
        node: string;
        turns: number;
        kos: number | null;
        cost: number;
        duration: number;
        input: number;
        output: number;
        cache_read: number;
        cache_write: number;
      };
      return (turnStatsStmt.all(since) as Row[]).map((row) => ({
        node: row.node,
        turns: row.turns,
        kos: row.kos ?? 0,
        costUsd: row.cost,
        durationMs: row.duration,
        tokens: { input: row.input, output: row.output, cacheRead: row.cache_read, cacheWrite: row.cache_write },
      }));
    },
    questXp() {
      type Row = { session: string; node: string; won: number; kos: number; completed: number };
      return (questXpStmt.all() as Row[]).map((row) => ({
        session: row.session,
        node: row.node,
        won: row.won,
        kos: row.kos,
        completed: row.completed === 1,
      }));
    },
    waiting() {
      return waitingStmt.all() as { session: string; node: string }[];
    },
    activity(limit) {
      type Row = { session: string; node: string; label: string; ts: number; type: string; outcome: unknown };
      return (activityStmt.all(limit) as Row[]).map((row) => {
        const kind = row.type === 'session.started' ? 'started' : row.type === 'session.closed' ? 'closed' : 'turn';
        return {
          session: row.session,
          node: row.node,
          label: row.label,
          ts: row.ts,
          kind,
          ...(kind === 'turn' && typeof row.outcome === 'string' ? { outcome: row.outcome } : {}),
        };
      });
    },
    search(node, query, limit) {
      const pattern = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      return (searchStmt.all(node, pattern, limit) as (EventTableRow & { label: string })[]).map((row) => ({
        session: row.session,
        seq: row.seq,
        label: row.label,
        event: toEnvelope(row),
      }));
    },
    nextSeq(session) {
      const row = maxSeqStmt.get(session) as { seq: number | null };
      return row.seq === null ? 0 : row.seq + 1;
    },
    releaseOrphans(node, held) {
      const keep = new Set(held);
      const orphans = (runningOnNodeStmt.all(node) as { id: string }[])
        .map((row) => row.id)
        .filter((id) => !keep.has(id));
      for (const id of orphans) setStatusStmt.run('idle', id);
      return orphans;
    },
    latestUsage() {
      return [...usage.values()].sort((a, b) => a.node.localeCompare(b.node));
    },
    getSession(id) {
      const row = getSessionStmt.get(id) as SessionTableRow | undefined;
      return row ? toSessionRow(row) : undefined;
    },
    sessionEngine(id) {
      const row = startedPayloadStmt.get(id) as { payload: string } | undefined;
      if (!row) return undefined;
      const engine = Engine.safeParse((JSON.parse(row.payload) as { engine?: unknown }).engine);
      return engine.success && engine.data !== 'stream' ? engine.data : undefined;
    },
    sessionEffort(id) {
      const row = startedPayloadStmt.get(id) as { payload: string } | undefined;
      if (!row) return undefined;
      const effort = Effort.safeParse((JSON.parse(row.payload) as { effort?: unknown }).effort);
      return effort.success ? effort.data : undefined;
    },
    putPushSubscription(subscription, prefs) {
      putPushStmt.run(subscription.endpoint, JSON.stringify(subscription.keys), JSON.stringify(prefs), Date.now());
    },
    deletePushSubscription(endpoint) {
      return deletePushStmt.run(endpoint).changes > 0;
    },
    listPushSubscriptions() {
      const rows = listPushStmt.all() as { endpoint: string; keys: string; prefs: string }[];
      return rows.flatMap((row) => {
        const subscription = PushSubscriptionJson.safeParse({ endpoint: row.endpoint, keys: JSON.parse(row.keys) });
        const prefs = PushPrefs.safeParse(JSON.parse(row.prefs));
        return subscription.success && prefs.success ? [{ subscription: subscription.data, prefs: prefs.data }] : [];
      });
    },
    getAppearance(login) {
      const row = getAppearanceStmt.get(login) as { data: string } | undefined;
      const parsed = row ? Appearance.safeParse(JSON.parse(row.data)) : undefined;
      return parsed?.success ? parsed.data : undefined;
    },
    putAppearance(login, appearance) {
      putAppearanceStmt.run(login, JSON.stringify(appearance), Date.now());
    },
    close() {
      db.close();
    },
  };
}
