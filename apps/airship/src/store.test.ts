import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Envelope } from '@crystal-bridge/protocol';
import { openStore, type Store } from './store.js';

function makeEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    node: 'local',
    session: randomUUID(),
    seq: 0,
    ts: Date.now(),
    type: 'claude.event',
    payload: { engine: 'claude', raw: { type: 'system', subtype: 'init' } },
    ...overrides,
  };
}

describe('store', () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('forgets a node: its sessions, events, relay counts and usage go, and other nodes are untouched', () => {
    const gone = randomUUID();
    const kept = randomUUID();
    store.appendEvent(
      makeEnvelope({
        node: 'gone',
        session: gone,
        type: 'session.started',
        payload: { cwd: '/a', prompt: 'a', label: 'a' },
      }),
    );
    store.appendEvent(makeEnvelope({ node: 'gone', session: gone, seq: 1 }));
    store.appendEvent(
      makeEnvelope({
        node: 'kept',
        session: kept,
        type: 'session.started',
        payload: { cwd: '/b', prompt: 'b', label: 'b' },
      }),
    );
    store.addRelayed(
      new Map([
        [gone, 10],
        [kept, 20],
      ]),
    );
    store.appendEvent(makeEnvelope({ node: 'gone', session: gone, seq: 2, type: 'usage', payload: { windows: [] } }));

    expect(store.forgetNode('gone')).toEqual([gone]);

    expect(store.listSessions().map((s) => s.id)).toEqual([kept]);
    expect(store.getSession(gone)).toBeUndefined();
    expect(store.eventsSince(gone, -1)).toEqual([]);
    expect(store.search('gone', 'a', 10)).toEqual([]);
    expect(store.latestUsage().map((u) => u.node)).not.toContain('gone');
    expect(store.eventsSince(kept, -1)).toHaveLength(1);
    expect(store.listSessions()[0]?.relayedBytes).toBe(20);
  });

  it('forgetting a node it has never heard of changes nothing', () => {
    expect(store.forgetNode('nobody')).toEqual([]);
  });

  it('returns an appended event with its payload deserialized', () => {
    const session = randomUUID();
    const event = makeEnvelope({ session, seq: 0, payload: { foo: 'bar' } });

    store.appendEvent(event);

    expect(store.eventsSince(session, 0)).toEqual([event]);
  });

  it('stores one row and returns false on a resent (session, seq) pair', () => {
    const session = randomUUID();
    const event = makeEnvelope({ session, seq: 0 });

    expect(store.appendEvent(event)).toBe(true);
    expect(store.appendEvent(event)).toBe(false);
    expect(store.eventsSince(session, 0)).toHaveLength(1);
  });

  it('returns only events with seq >= the given value, ordered by seq', () => {
    const session = randomUUID();
    // insert out of order so the ordering must come from the query, not insertion order
    for (const seq of [10, 0, 6, 1, 5]) {
      store.appendEvent(makeEnvelope({ session, seq }));
    }

    const result = store.eventsSince(session, 5);

    expect(result.map((event) => event.seq)).toEqual([5, 6, 10]);
  });

  it('lists each session with the time of its latest event, so clients can tell recent work from old', () => {
    const session = randomUUID();
    store.appendEvent(
      makeEnvelope({
        session,
        seq: 0,
        ts: 100,
        type: 'session.started',
        payload: { cwd: '/r', prompt: 'p', label: 'p' },
      }),
    );
    // The latest event is the highest seq, whatever order the events arrived in.
    store.appendEvent(makeEnvelope({ session, seq: 7, ts: 900 }));
    store.appendEvent(makeEnvelope({ session, seq: 3, ts: 500 }));
    expect(store.listSessions()[0]).toMatchObject({ id: session, createdAt: 100, lastActivity: 900 });
  });

  it('adds up the bytes relayed to clients per session and lists them, zero for none', () => {
    const [a, b] = [randomUUID(), randomUUID()];
    for (const [session, ts] of [
      [a, 100],
      [b, 200],
    ] as const) {
      store.appendEvent(
        makeEnvelope({ session, seq: 0, ts, type: 'session.started', payload: { cwd: '/r', prompt: 'p', label: 'p' } }),
      );
    }
    store.addRelayed(new Map([[a, 1200]]));
    store.addRelayed(new Map([[a, 34]]));
    const listed = Object.fromEntries(store.listSessions().map((s) => [s.id, s.relayedBytes]));
    expect(listed).toEqual({ [a]: 1234, [b]: 0 });
  });

  it('creates a running session from session.started and ends it on session.ended', () => {
    const session = randomUUID();
    const createdAt = Date.now();
    const started = makeEnvelope({
      session,
      seq: 0,
      node: 'local',
      ts: createdAt,
      type: 'session.started',
      payload: { cwd: '/tmp/repo', prompt: 'say hello', label: 'demo' },
    });

    store.appendEvent(started);

    expect(store.listSessions()).toEqual([
      {
        id: session,
        node: 'local',
        cwd: '/tmp/repo',
        label: 'demo',
        status: 'running',
        createdAt,
        lastActivity: createdAt,
        relayedBytes: 0,
      },
    ]);
    expect(store.getSession(session)).toEqual({
      id: session,
      node: 'local',
      cwd: '/tmp/repo',
      label: 'demo',
      status: 'running',
      createdAt,
    });

    const ended = makeEnvelope({
      session,
      seq: 1,
      type: 'session.ended',
      payload: { exitCode: 0, signal: null, reason: 'exit' },
    });
    store.appendEvent(ended);

    expect(store.getSession(session)).toEqual({
      id: session,
      node: 'local',
      cwd: '/tmp/repo',
      label: 'demo',
      status: 'ended',
      createdAt,
    });
  });

  it('marks an idle stop as idle, and running again on session.resumed', () => {
    const session = randomUUID();
    store.appendEvent(
      makeEnvelope({
        session,
        seq: 0,
        type: 'session.started',
        payload: { cwd: '/tmp/repo', prompt: 'hi', label: 'hi' },
      }),
    );

    store.appendEvent(
      makeEnvelope({ session, seq: 1, type: 'session.ended', payload: { exitCode: 0, signal: null, reason: 'idle' } }),
    );
    expect(store.getSession(session)?.status).toBe('idle');

    store.appendEvent(makeEnvelope({ session, seq: 2, type: 'session.resumed', payload: {} }));
    expect(store.getSession(session)?.status).toBe('running');

    store.appendEvent(
      makeEnvelope({ session, seq: 3, type: 'session.ended', payload: { exitCode: 0, signal: null, reason: 'exit' } }),
    );
    expect(store.getSession(session)?.status).toBe('ended');

    store.appendEvent(makeEnvelope({ session, seq: 4, type: 'session.resumed', payload: {} }));
    expect(store.getSession(session)?.status).toBe('running');
  });

  it('treats a session.ended with no reason as ended', () => {
    const session = randomUUID();
    store.appendEvent(
      makeEnvelope({
        session,
        seq: 0,
        type: 'session.started',
        payload: { cwd: '/tmp/repo', prompt: 'hi', label: 'hi' },
      }),
    );
    store.appendEvent(makeEnvelope({ session, seq: 1, type: 'session.ended', payload: { exitCode: 0, signal: null } }));
    expect(store.getSession(session)?.status).toBe('ended');
  });

  it('keeps the latest usage per node', () => {
    const windows = (usedPct: number) => ({
      windows: [{ id: 'five_hour', label: '5h', usedPct, resetsAt: null, status: 'allowed' }],
    });
    store.appendEvent(makeEnvelope({ node: 'node-a', seq: 0, ts: 100, type: 'usage', payload: windows(10) }));
    store.appendEvent(makeEnvelope({ node: 'node-a', seq: 0, ts: 300, type: 'usage', payload: windows(30) }));
    store.appendEvent(makeEnvelope({ node: 'node-a', seq: 0, ts: 200, type: 'usage', payload: windows(20) }));
    store.appendEvent(makeEnvelope({ node: 'node-b', seq: 0, ts: 150, type: 'usage', payload: windows(5) }));

    expect(store.latestUsage()).toEqual([
      { node: 'node-a', ts: 300, ...windows(30) },
      { node: 'node-b', ts: 150, ...windows(5) },
    ]);
  });

  it('ignores a usage event whose payload does not match the schema', () => {
    store.appendEvent(makeEnvelope({ node: 'node-a', seq: 0, ts: 100, type: 'usage', payload: { windows: 'full' } }));
    expect(store.latestUsage()).toEqual([]);
  });

  it('restores the latest usage per node from disk when reopened', () => {
    const dir = mkdtempSync(join(tmpdir(), 'airship-store-'));
    try {
      const path = join(dir, 'airship.db');
      const first = openStore(path);
      const payload = { windows: [{ id: 'seven_day', label: '7d', usedPct: 4, resetsAt: 5, status: 'allowed' }] };
      first.appendEvent(makeEnvelope({ node: 'node-a', seq: 0, ts: 100, type: 'usage', payload }));
      first.appendEvent(makeEnvelope({ node: 'node-a', seq: 0, ts: 50, type: 'usage', payload: { windows: [] } }));
      first.close();

      const reopened = openStore(path);
      expect(reopened.latestUsage()).toEqual([{ node: 'node-a', ts: 100, ...payload }]);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports the engine a session started on, read from its session.started (none for the default)', () => {
    const [plain, interactive] = [randomUUID(), randomUUID()];
    store.appendEvent(
      makeEnvelope({ session: plain, type: 'session.started', payload: { cwd: '/w', prompt: 'p', label: 'p' } }),
    );
    store.appendEvent(
      makeEnvelope({
        session: interactive,
        type: 'session.started',
        payload: { cwd: '/w', prompt: 'p', label: 'p', engine: 'interactive' },
      }),
    );
    expect(store.sessionEngine(plain)).toBeUndefined();
    expect(store.sessionEngine(interactive)).toBe('interactive');
    expect(store.sessionEngine(randomUUID())).toBeUndefined();
  });

  it('reports the effort a session started with, read from its session.started (none when unset or unknown)', () => {
    const [plain, high, odd] = [randomUUID(), randomUUID(), randomUUID()];
    const start = (session: string, extra: Record<string, unknown>) =>
      store.appendEvent(
        makeEnvelope({ session, type: 'session.started', payload: { cwd: '/w', prompt: 'p', label: 'p', ...extra } }),
      );
    start(plain, {});
    start(high, { effort: 'high' });
    start(odd, { effort: 'ludicrous' });
    expect(store.sessionEffort(plain)).toBeUndefined();
    expect(store.sessionEffort(high)).toBe('high');
    expect(store.sessionEffort(odd)).toBeUndefined();
  });

  it('reports the next free seq of a session', () => {
    const session = randomUUID();
    expect(store.nextSeq(session)).toBe(0);
    for (const seq of [0, 1, 5]) store.appendEvent(makeEnvelope({ session, seq }));
    expect(store.nextSeq(session)).toBe(6);
  });

  it('marks a node-s running sessions idle unless the node still holds them', () => {
    const start = (session: string, node: string) =>
      store.appendEvent(
        makeEnvelope({
          session,
          node,
          seq: 0,
          type: 'session.started',
          payload: { cwd: '/tmp/r', prompt: 'p', label: 'p' },
        }),
      );
    const [held, orphan, ended, other] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    start(held, 'node-a');
    start(orphan, 'node-a');
    start(ended, 'node-a');
    start(other, 'node-b');
    store.appendEvent(
      makeEnvelope({
        session: ended,
        node: 'node-a',
        seq: 1,
        type: 'session.ended',
        payload: { exitCode: 0, signal: null, reason: 'exit' },
      }),
    );

    expect(store.releaseOrphans('node-a', [held])).toEqual([orphan]);

    expect(store.getSession(held)?.status).toBe('running');
    expect(store.getSession(orphan)?.status).toBe('idle');
    expect(store.getSession(ended)?.status).toBe('ended');
    expect(store.getSession(other)?.status).toBe('running');
  });

  it('starts an adopted session as idle, since nothing is running until a follow-up', () => {
    const session = randomUUID();
    store.appendEvent(
      makeEnvelope({
        session,
        seq: 0,
        type: 'session.started',
        payload: { cwd: '/r', prompt: 'p', label: 'p', adopted: true },
      }),
    );
    expect(store.getSession(session)?.status).toBe('idle');
  });

  it('marks a closed session closed, and keeps it closed', () => {
    const session = randomUUID();
    store.appendEvent(
      makeEnvelope({ session, seq: 0, type: 'session.started', payload: { cwd: '/r', prompt: 'p', label: 'p' } }),
    );
    store.appendEvent(makeEnvelope({ session, seq: 1, type: 'session.closed', payload: {} }));
    expect(store.getSession(session)?.status).toBe('closed');
    expect(store.releaseOrphans(session, [])).toEqual([]);
    // The process exits after the close; its end (or a stray resume) must not reopen the Quest.
    store.appendEvent(
      makeEnvelope({ session, seq: 2, type: 'session.ended', payload: { exitCode: 0, signal: null, reason: 'exit' } }),
    );
    store.appendEvent(makeEnvelope({ session, seq: 3, type: 'session.resumed', payload: {} }));
    expect(store.getSession(session)?.status).toBe('closed');
  });

  it('searches one node-s history, newest first, case-insensitively, with each match-s session label', () => {
    const [a, b, other] = [randomUUID(), randomUUID(), randomUUID()];
    const start = (session: string, node: string, label: string) =>
      store.appendEvent(
        makeEnvelope({
          session,
          node,
          seq: 0,
          ts: 1,
          type: 'session.started',
          payload: { cwd: '/w', prompt: label, label },
        }),
      );
    start(a, 'node-a', 'Fix the Flaky test');
    start(b, 'node-a', 'Write docs');
    start(other, 'node-b', 'flaky elsewhere');
    store.appendEvent(
      makeEnvelope({
        session: b,
        node: 'node-a',
        seq: 1,
        ts: 5,
        type: 'user.message',
        payload: { text: 'also mention the flaky one' },
      }),
    );
    store.appendEvent(
      makeEnvelope({
        session: b,
        node: 'node-a',
        seq: 2,
        ts: 6,
        type: 'usage',
        payload: { windows: [{ id: 'flaky' }] },
      }),
    );

    const hits = store.search('node-a', 'FLAKY', 10);
    expect(hits.map((h) => [h.session, h.seq, h.label])).toEqual([
      [b, 1, 'Write docs'],
      [a, 0, 'Fix the Flaky test'],
    ]);
    expect(hits[0]!.event.payload).toEqual({ text: 'also mention the flaky one' });
  });

  it('treats search wildcards in the query as plain text', () => {
    const s1 = randomUUID();
    store.appendEvent(
      makeEnvelope({
        session: s1,
        node: 'node-a',
        seq: 0,
        ts: 1,
        type: 'session.started',
        payload: { cwd: '/w', prompt: 'p', label: 'p' },
      }),
    );
    store.appendEvent(
      makeEnvelope({ session: s1, node: 'node-a', seq: 1, ts: 2, type: 'user.message', payload: { text: 'anything' } }),
    );
    expect(store.search('node-a', '%', 10)).toEqual([]);
  });

  it('keeps one push subscription per endpoint, with its device-s latest prefs, until deleted', () => {
    const subscription = { endpoint: 'https://push.example/a', keys: { p256dh: 'p', auth: 'a' } };
    store.putPushSubscription(subscription, { names: {}, hidden: [] });
    store.putPushSubscription(subscription, { names: { n: 'A' }, hidden: ['m'], notify: { n: 'discreet' } });
    const other = { endpoint: 'https://push.example/b', keys: { p256dh: 'q', auth: 'b' } };
    store.putPushSubscription(other, { names: {}, hidden: [] });
    expect(store.listPushSubscriptions()).toEqual([
      { subscription, prefs: { names: { n: 'A' }, hidden: ['m'], notify: { n: 'discreet' } } },
      { subscription: other, prefs: { names: {}, hidden: [] } },
    ]);
    expect(store.deletePushSubscription(subscription.endpoint)).toBe(true);
    expect(store.deletePushSubscription(subscription.endpoint)).toBe(false);
    expect(store.listPushSubscriptions().map((row) => row.subscription.endpoint)).toEqual([other.endpoint]);
  });

  it('keeps one appearance per user, the last write winning', () => {
    expect(store.getAppearance('a@example.com')).toBeUndefined();
    store.putAppearance('a@example.com', { tabStyle: 'tinted' });
    store.putAppearance('b@example.com', { looks: { n: { icon: 'ship' } } });
    store.putAppearance('a@example.com', { tabStyle: 'pennant', looks: { n: { colour: '#3550c8' } } });
    expect(store.getAppearance('a@example.com')).toEqual({ tabStyle: 'pennant', looks: { n: { colour: '#3550c8' } } });
    expect(store.getAppearance('b@example.com')).toEqual({ looks: { n: { icon: 'ship' } } });
  });

  describe('what is waiting on the user', () => {
    const ask = (session: string, seq: number, requestId: string): Envelope =>
      makeEnvelope({ session, seq, type: 'permission.request', payload: { requestId, toolName: 'Bash', input: {} } });
    const started = (session: string): Envelope =>
      makeEnvelope({ session, seq: 0, type: 'session.started', payload: { cwd: '/w', prompt: 'p', label: 'p' } });

    it('lists a Quest with a request nobody has answered, once', () => {
      const session = randomUUID();
      store.appendEvent(started(session));
      store.appendEvent(ask(session, 1, 'a'));
      store.appendEvent(ask(session, 2, 'b'));
      expect(store.waiting()).toEqual([{ session, node: 'local' }]);
    });

    it('drops it once every request is answered, even out of order', () => {
      const session = randomUUID();
      store.appendEvent(started(session));
      store.appendEvent(ask(session, 1, 'a'));
      store.appendEvent(ask(session, 2, 'b'));
      const resolved = (seq: number, requestId: string) =>
        makeEnvelope({ session, seq, type: 'permission.resolved', payload: { requestId, behavior: 'allow' } });
      store.appendEvent(resolved(3, 'b'));
      expect(store.waiting()).toHaveLength(1);
      store.appendEvent(resolved(4, 'a'));
      expect(store.waiting()).toEqual([]);
    });

    it.each(['session.ended', 'session.closed'] as const)('drops it after %s: nobody can answer now', (type) => {
      const session = randomUUID();
      store.appendEvent(started(session));
      store.appendEvent(ask(session, 1, 'a'));
      store.appendEvent(makeEnvelope({ session, seq: 2, type, payload: {} }));
      expect(store.waiting()).toEqual([]);
    });
  });

  describe('home page data', () => {
    const start = (session: string, node: string, label: string, ts: number) =>
      store.appendEvent(
        makeEnvelope({
          session,
          node,
          seq: 0,
          ts,
          type: 'session.started',
          payload: { cwd: '/r', prompt: label, label },
        }),
      );
    const finish = (session: string, node: string, seq: number, ts: number, payload: Record<string, unknown>) =>
      store.appendEvent(makeEnvelope({ session, node, seq, ts, type: 'turn.finished', payload }));

    it('sums finished turns per node since a time: turns, KOs, cost, time and tokens', () => {
      const [a, b] = [randomUUID(), randomUUID()];
      start(a, 'n1', 'a', 100);
      start(b, 'n2', 'b', 100);
      finish(a, 'n1', 1, 50, { outcome: 'success', costUsd: 9 }); // before `since`: not counted
      finish(a, 'n1', 2, 200, {
        outcome: 'success',
        costUsd: 0.25,
        durationMs: 1000,
        tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      });
      finish(a, 'n1', 3, 300, { outcome: 'error' });
      finish(b, 'n2', 1, 300, { outcome: 'interrupted', costUsd: 0.5 });
      expect(store.turnStats(150)).toEqual([
        {
          node: 'n1',
          turns: 2,
          kos: 1,
          costUsd: 0.25,
          durationMs: 1000,
          tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
        },
        {
          node: 'n2',
          turns: 1,
          kos: 0,
          costUsd: 0.5,
          durationMs: 0,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ]);
    });

    it("counts each Quest's lifetime battles for levels: won, KOs, and whether it was completed", () => {
      const [a, b] = [randomUUID(), randomUUID()];
      start(a, 'n1', 'a', 100);
      start(b, 'n2', 'b', 100);
      finish(a, 'n1', 1, 200, { outcome: 'success' });
      finish(a, 'n1', 2, 300, { outcome: 'success' });
      finish(a, 'n1', 3, 400, { outcome: 'error' });
      finish(a, 'n1', 4, 500, { outcome: 'interrupted' });
      store.appendEvent(makeEnvelope({ session: a, node: 'n1', seq: 5, ts: 600, type: 'session.closed', payload: {} }));
      finish(b, 'n2', 1, 200, { outcome: 'success' });
      expect(store.questXp().sort((x, y) => x.node.localeCompare(y.node))).toEqual([
        { session: a, node: 'n1', won: 2, kos: 1, completed: true },
        { session: b, node: 'n2', won: 1, kos: 0, completed: false },
      ]);
    });

    it('lists recent activity, newest first: Quests started and closed, turns finished, with labels', () => {
      const a = randomUUID();
      start(a, 'n1', 'Fix it', 100);
      finish(a, 'n1', 1, 200, { outcome: 'success', summary: 'Done' });
      store.appendEvent(makeEnvelope({ session: a, node: 'n1', seq: 2, ts: 300, type: 'session.closed', payload: {} }));
      expect(store.activity(2)).toEqual([
        { session: a, node: 'n1', label: 'Fix it', ts: 300, kind: 'closed' },
        { session: a, node: 'n1', label: 'Fix it', ts: 200, kind: 'turn', outcome: 'success' },
      ]);
    });

    it('gives each listed session a preview: its latest finished turn-s summary', () => {
      const a = randomUUID();
      start(a, 'n1', 'a', 100);
      finish(a, 'n1', 1, 200, { outcome: 'success', summary: 'First' });
      finish(a, 'n1', 2, 300, { outcome: 'success', summary: 'Second' });
      expect(store.listSessions().find((s) => s.id === a)?.preview).toBe('Second');
    });
  });
});
