import type {
  Cast,
  Patrol,
  PatrolManifest,
  PatrolRun,
  Scout,
  ScoutItem,
  ScoutManifest,
  ScoutRun,
} from '@crystal-bridge/protocol';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { umask } from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '@crystal-bridge/protocol';
import {
  ERRANDS_KEPT_MS,
  errandProject,
  GONE_ITEMS_KEPT_MS,
  openStore,
  PATROL_RUNS_KEPT,
  PATROL_RUNS_SHOWN,
  SCOUT_RUNS_KEPT,
  SCOUT_RUNS_SHOWN,
  type Store,
} from './store.js';

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

  it('forgets a node: its sessions, events, relay counts and usage go, and other nodes are untouched', async () => {
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
    expect(await store.search('gone', 'a', 10)).toEqual([]);
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

  describe('Quest titles (#287)', () => {
    const start = (session: string) =>
      store.appendEvent(
        makeEnvelope({
          session,
          seq: 0,
          type: 'session.started',
          payload: { cwd: '/r', prompt: 'fix it', label: 'fix it' },
        }),
      );
    const titled = (session: string, seq: number, title: string, plain: string) =>
      store.appendEvent(makeEnvelope({ session, seq, type: 'quest.titled', payload: { title, plain } }));
    const listed = (session: string) => store.listSessions().find((row) => row.id === session);

    it('takes the title a Quest gives itself, with its plain form, and only the first', () => {
      const session = randomUUID();
      start(session);
      titled(session, 1, 'The Siege of the Flaky Smoke Test', 'Fix the flaky smoke test');
      expect(listed(session)).toMatchObject({
        label: 'The Siege of the Flaky Smoke Test',
        plainLabel: 'Fix the flaky smoke test',
      });
      expect(store.getSession(session)?.label).toBe('The Siege of the Flaky Smoke Test');
      titled(session, 2, 'The Smoke Clears', 'Rewrite the smoke test');
      expect(listed(session)).toMatchObject({
        label: 'The Siege of the Flaky Smoke Test',
        plainLabel: 'Fix the flaky smoke test',
      });
    });

    it('takes a first title after one it could not read', () => {
      const session = randomUUID();
      start(session);
      store.appendEvent(makeEnvelope({ session, seq: 1, type: 'quest.titled', payload: { title: '' } }));
      titled(session, 2, 'The Siege', 'Fix the test');
      expect(listed(session)).toMatchObject({ label: 'The Siege', plainLabel: 'Fix the test' });
    });

    it('keeps a title set by hand, in every theme, whatever the Quest calls itself later', () => {
      const session = randomUUID();
      start(session);
      titled(session, 1, 'The Siege', 'Fix the test');
      expect(store.renameSession(session, 'Smoke test, again')).toBe(true);
      expect(listed(session)?.label).toBe('Smoke test, again');
      expect(listed(session)).not.toHaveProperty('plainLabel');
      titled(session, 2, 'The Smoke Clears', 'Rewrite the smoke test');
      expect(listed(session)?.label).toBe('Smoke test, again');
      expect(listed(session)).not.toHaveProperty('plainLabel');
    });

    it('stores a title it cannot read as an event, and leaves the label alone', () => {
      const session = randomUUID();
      start(session);
      expect(store.appendEvent(makeEnvelope({ session, seq: 1, type: 'quest.titled', payload: { title: '' } }))).toBe(
        true,
      );
      expect(listed(session)?.label).toBe('fix it');
    });

    it('gives the plain name with the title in the activity feed and search hits', async () => {
      const session = randomUUID();
      start(session);
      titled(session, 1, 'The Siege', 'Fix the test');
      expect(store.activity(10).find((item) => item.session === session)).toMatchObject({
        label: 'The Siege',
        plainLabel: 'Fix the test',
      });
      const hits = await store.search('local', 'fix it', 10);
      expect(hits.find((hit) => hit.session === session)).toMatchObject({
        label: 'The Siege',
        plainLabel: 'Fix the test',
      });
    });

    it('renames only a Quest it has', () => {
      expect(store.renameSession(randomUUID(), 'x')).toBe(false);
    });
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

  it('follows a Quest’s latest choice of effort, including back to the CLI default', () => {
    const session = randomUUID();
    const change = (seq: number, payload: unknown) =>
      store.appendEvent(makeEnvelope({ session, seq, type: 'session.effort', payload }));
    store.appendEvent(
      makeEnvelope({
        session,
        type: 'session.started',
        payload: { cwd: '/w', prompt: 'p', label: 'p', effort: 'high' },
      }),
    );
    change(1, { effort: 'low' });
    change(2, { effort: 'max' });
    expect(store.sessionEffort(session)).toBe('max');
    change(3, {});
    expect(store.sessionEffort(session)).toBeUndefined();
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

  it('searches one node-s history, newest first, case-insensitively, with each match-s session label', async () => {
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

    const hits = await store.search('node-a', 'FLAKY', 10);
    expect(hits.map((h) => [h.session, h.seq, h.label])).toEqual([
      [b, 1, 'Write docs'],
      [a, 0, 'Fix the Flaky test'],
    ]);
    expect(hits[0]!.event.payload).toEqual({ text: 'also mention the flaky one' });
  });

  it('leaves Inventory descriptions out of search, since they-d match every Quest', async () => {
    const session = randomUUID();
    store.appendEvent(
      makeEnvelope({
        session,
        node: 'node-a',
        seq: 0,
        ts: 1,
        type: 'claude.event',
        payload: {
          engine: 'claude',
          raw: { type: 'system', subtype: 'descriptions', descriptions: { deploy: 'Ships the needle' } },
        },
      }),
    );
    expect(await store.search('node-a', 'needle', 10)).toEqual([]);
  });

  describe('searching a long history', () => {
    const started = (session: string, ts: number) =>
      store.appendEvent(
        makeEnvelope({
          session,
          node: 'node-a',
          seq: 0,
          ts,
          type: 'session.started',
          payload: { cwd: '/w', prompt: 'p', label: 'p' },
        }),
      );
    const said = (session: string, seq: number, text: string, ts = seq) =>
      store.appendEvent(makeEnvelope({ session, node: 'node-a', seq, ts, type: 'user.message', payload: { text } }));
    const fragment = (session: string, seq: number, text: string) =>
      store.appendEvent(
        makeEnvelope({
          session,
          node: 'node-a',
          seq,
          ts: seq,
          type: 'claude.event',
          payload: { engine: 'claude', raw: { type: 'stream_event', event: { delta: { text } } } },
        }),
      );

    afterEach(() => vi.restoreAllMocks());

    it('leaves out streaming fragments, whose text the full messages carry', async () => {
      const session = randomUUID();
      started(session, 1);
      fragment(session, 1, 'needle');
      said(session, 2, 'needle');
      expect((await store.search('node-a', 'needle', 10)).map((hit) => hit.seq)).toEqual([2]);
    });

    it('stops at the limit in the Quests most recently active, whenever they started', async () => {
      const [older, newer] = [randomUUID(), randomUUID()];
      started(older, 1);
      started(newer, 2);
      said(newer, 1, 'needle', 10);
      said(older, 1, 'needle', 20);
      expect((await store.search('node-a', 'needle', 1)).map((hit) => hit.session)).toEqual([older]);
    });

    it('lets the hub breathe between steps instead of freezing every Quest', async () => {
      const session = randomUUID();
      started(session, 1);
      for (let seq = 1; seq <= 6000; seq++) said(session, seq, 'hay');
      let turns = 0;
      let searching = true;
      const count = () => {
        turns++;
        if (searching) setImmediate(count);
      };
      setImmediate(count);

      await store.search('node-a', 'needle', 10);
      searching = false;

      expect(turns).toBeGreaterThan(1);
    });

    it('stops looking when its time is up, and returns what it found', async () => {
      const session = randomUUID();
      started(session, 1);
      for (let seq = 1; seq <= 6000; seq++) said(session, seq, 'needle in the hay', seq);
      said(session, 6001, 'needle at the top', 6001);
      const now = Date.now();
      vi.spyOn(Date, 'now')
        .mockReturnValueOnce(now)
        .mockReturnValue(now + 60 * 60_000);

      const hits = await store.search('node-a', 'needle', 100_000);

      expect(hits[0]?.seq).toBe(6001);
      expect(hits.length).toBeLessThan(6001);
    });

    it('sees every step of a long Quest, not only its newest', async () => {
      const session = randomUUID();
      started(session, 1);
      said(session, 1, 'needle');
      for (let seq = 2; seq <= 6000; seq++) said(session, seq, 'hay');
      expect((await store.search('node-a', 'needle', 10)).map((hit) => hit.seq)).toEqual([1]);
    });
  });

  it('reads a null session.effort or session.mode payload as unset, whatever a node sends', () => {
    const session = randomUUID();
    store.appendEvent(
      makeEnvelope({
        session,
        seq: 0,
        type: 'session.started',
        payload: { cwd: '/w', prompt: 'p', label: 'p', mode: 'auto', effort: 'high' },
      }),
    );
    store.appendEvent(makeEnvelope({ session, seq: 1, type: 'session.effort', payload: null }));
    store.appendEvent(makeEnvelope({ session, seq: 2, type: 'session.mode', payload: null }));
    expect(store.sessionEffort(session)).toBeUndefined();
    expect(store.sessionMode(session)).toBeUndefined();
  });

  it('reads a null user.message payload as a prompt with no words', () => {
    const session = randomUUID();
    store.appendEvent(
      makeEnvelope({
        session,
        seq: 0,
        ts: 1,
        type: 'session.started',
        payload: { cwd: '/w', prompt: 'p', label: 'p' },
      }),
    );
    store.appendEvent(makeEnvelope({ session, seq: 1, ts: 2, type: 'user.message', payload: null }));
    expect(store.cutOffTurn(session)).toEqual({ prompt: '', lastActivity: 2 });
  });

  it.skipIf(process.platform === 'win32')('keeps the database and its -wal and -shm private', () => {
    const dir = mkdtempSync(join(tmpdir(), 'airship-private-'));
    const path = join(dir, 'airship.db');
    const previous = umask(0o022);
    try {
      const fresh = openStore(path);
      fresh.appendEvent(makeEnvelope());
      for (const file of [path, `${path}-wal`, `${path}-shm`]) expect(statSync(file).mode & 0o777).toBe(0o600);
      fresh.close();

      // An install from before this: every file already as the umask left it.
      const crashed = openStore(path);
      crashed.appendEvent(makeEnvelope());
      for (const file of [path, `${path}-wal`, `${path}-shm`]) chmodSync(file, 0o644);
      const reopened = openStore(path);
      for (const file of [path, `${path}-wal`, `${path}-shm`]) expect(statSync(file).mode & 0o777).toBe(0o600);
      reopened.close();
      crashed.close();
    } finally {
      umask(previous);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats search wildcards in the query as plain text', async () => {
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
    expect(await store.search('node-a', '%', 10)).toEqual([]);
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

    it('lists a Quest whose terminal is asking, until it closes or the Quest ends', () => {
      const session = randomUUID();
      const screen = (seq: number, payload: unknown): Envelope =>
        makeEnvelope({ session, seq, type: 'terminal.screen', payload });
      store.appendEvent(started(session));
      store.appendEvent(screen(1, { open: true, raised: true, held: false, text: 'Pick one' }));
      store.appendEvent(screen(2, { open: true, text: 'Pick two' }));
      expect(store.waiting()).toEqual([{ session, node: 'local' }]);
      store.appendEvent(screen(3, { open: false }));
      expect(store.waiting()).toEqual([]);
      store.appendEvent(screen(4, { open: true, raised: true, held: false, text: 'Again' }));
      expect(store.waiting()).toHaveLength(1);
      store.appendEvent(makeEnvelope({ session, seq: 5, type: 'session.closed', payload: {} }));
      expect(store.waiting()).toEqual([]);
    });

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

  describe('finished Quests the user has not seen', () => {
    const started = (session: string): Envelope =>
      makeEnvelope({ session, seq: 0, type: 'session.started', payload: { cwd: '/w', prompt: 'p', label: 'p' } });
    const turn = (session: string, seq: number, outcome: string, ts = Date.now()): Envelope =>
      makeEnvelope({ session, seq, ts, type: 'turn.finished', payload: { outcome } });
    const ended = (session: string, seq: number, payload: Record<string, unknown>): Envelope =>
      makeEnvelope({ session, seq, type: 'session.ended', payload: { exitCode: null, signal: null, ...payload } });

    it('lists a finished turn until that login has seen it, and only for that login', () => {
      const session = randomUUID();
      store.appendEvent(started(session));
      store.appendEvent(turn(session, 1, 'success'));
      expect(store.unseen('a')).toEqual([{ session, node: 'local', reason: 'done', at: expect.any(Number) }]);
      store.markSeen('a', session);
      expect(store.unseen('a')).toEqual([]);
      expect(store.unseen('b')).toHaveLength(1);
    });

    it('lists it again when a later turn finishes', () => {
      const session = randomUUID();
      store.appendEvent(started(session));
      store.appendEvent(turn(session, 1, 'success'));
      store.markSeen('a', session);
      store.appendEvent(turn(session, 2, 'error'));
      expect(store.unseen('a')).toEqual([{ session, node: 'local', reason: 'failed', at: expect.any(Number) }]);
    });

    it('counts a crash or a restart with no resume as failed, after the turn that came before', () => {
      const crashed = randomUUID();
      const cut = randomUUID();
      const resumed = randomUUID();
      for (const s of [crashed, cut, resumed]) {
        store.appendEvent(started(s));
        store.appendEvent(turn(s, 1, 'success'));
      }
      store.appendEvent(ended(crashed, 2, { reason: 'error' }));
      store.appendEvent(ended(cut, 2, { reason: 'restart' }));
      store.appendEvent(ended(resumed, 2, { reason: 'restart', resuming: true }));
      const reasons = Object.fromEntries(store.unseen('a').map((u) => [u.session, u.reason]));
      expect(reasons).toEqual({ [crashed]: 'failed', [cut]: 'failed', [resumed]: 'done' });
    });

    it('keeps the finished turn when the process then exits or idles normally', () => {
      const session = randomUUID();
      store.appendEvent(started(session));
      store.appendEvent(turn(session, 1, 'success'));
      store.appendEvent(ended(session, 2, { reason: 'idle' }));
      expect(store.unseen('a').map((u) => u.reason)).toEqual(['done']);
    });

    it('leaves out an interrupted turn, a Quest with no finished turn, and a closed Quest', () => {
      const interrupted = randomUUID();
      const working = randomUUID();
      const closed = randomUUID();
      store.appendEvent(started(interrupted));
      store.appendEvent(turn(interrupted, 1, 'interrupted'));
      store.appendEvent(started(working));
      store.appendEvent(started(closed));
      store.appendEvent(turn(closed, 1, 'success'));
      store.appendEvent(makeEnvelope({ session: closed, seq: 2, type: 'session.closed', payload: {} }));
      expect(store.unseen('a')).toEqual([]);
    });

    it('leaves out turns that finished before the hub could keep track', () => {
      const session = randomUUID();
      store.appendEvent(started(session));
      store.appendEvent(turn(session, 1, 'success', 1));
      expect(store.unseen('a')).toEqual([]);
    });

    it('seen never goes backwards, and marking a Quest it has never heard of changes nothing', () => {
      const session = randomUUID();
      store.appendEvent(started(session));
      store.appendEvent(turn(session, 1, 'success'));
      store.markSeen('a', session);
      store.markSeen('a', randomUUID());
      expect(store.unseen('a')).toEqual([]);
    });

    it('forgets what was seen with the node', () => {
      const session = randomUUID();
      store.appendEvent(started(session));
      store.appendEvent(turn(session, 1, 'success'));
      store.markSeen('a', session);
      store.forgetNode('local');
      store.appendEvent(started(session));
      store.appendEvent(turn(session, 1, 'success'));
      expect(store.unseen('a')).toHaveLength(1);
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

describe('casts', () => {
  const cast: Cast = {
    id: '11111111-1111-4111-8111-111111111111',
    session: '22222222-2222-4222-8222-222222222222',
    summon: 'render',
    name: 'encode',
    command: 'encode all',
    onFinish: 'notify',
    state: 'running',
    startedAt: 5,
    logTail: '',
  };

  it('keeps the newest report of each Cast, for its own Kingdom only', () => {
    const store = openStore(':memory:');
    expect(store.upsertCast('a', cast)).toEqual(cast);
    store.upsertCast('a', { ...cast, logTail: 'more' });
    expect(store.casts('a', 10)).toEqual([{ ...cast, logTail: 'more' }]);
    expect(store.casts('b', 10)).toEqual([]);
    expect(store.upsertCast('b', { ...cast, logTail: 'taken over' })).toBeUndefined();
    expect(store.casts('a', 10)[0]!.logTail).toBe('more');
  });

  it('keeps a running Cast in the list however many newer ones have ended', () => {
    const store = openStore(':memory:');
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    store.upsertCast('a', cast);
    for (const n of [1, 2, 3]) {
      store.upsertCast('a', { ...cast, id: id(n), startedAt: 5 + n, state: 'succeeded', exitCode: 0 });
    }
    store.upsertCast('b', { ...cast, id: id(9) });
    expect(store.casts('a', 2).map((listed) => listed.id)).toEqual([id(3), id(2), cast.id]);
  });

  it('won’t let a late report undo a finished Cast', () => {
    const store = openStore(':memory:');
    store.upsertCast('a', { ...cast, state: 'succeeded', exitCode: 0 });
    expect(store.upsertCast('a', cast)).toBeUndefined();
    expect(store.casts('a', 10)[0]!.state).toBe('succeeded');
  });

  it('remembers once a Cast’s end was delivered, and forgets it with its Kingdom', () => {
    const store = openStore(':memory:');
    store.upsertCast('a', { ...cast, state: 'failed' });
    expect(store.castDelivered(cast.id)).toBe(false);
    store.markCastDelivered(cast.id);
    store.upsertCast('a', { ...cast, state: 'failed' });
    expect(store.castDelivered(cast.id)).toBe(true);
    store.forgetNode('a');
    expect(store.casts('a', 10)).toEqual([]);
  });
});

describe('Boards', () => {
  const manifest: ScoutManifest = {
    name: 'Quest Board',
    schedule: { cron: '*/15 * * * *', timezone: 'UTC' },
    collect: { command: ['./collect.sh'] },
    view: 'list',
    actions: { done: { kind: 'done', label: 'Done' } },
  };
  const scout: Scout = { id: 'quest-board', manifest };
  let runs = 0;
  const run = (extra: Partial<ScoutRun> = {}): ScoutRun => ({
    id: `00000000-0000-4000-8000-${String(++runs).padStart(12, '0')}`,
    startedAt: 1,
    finishedAt: 2,
    trigger: 'schedule',
    outcome: 'succeeded',
    ...extra,
  });
  const item = (id: string, rev = '1', extra: Partial<ScoutItem> = {}): ScoutItem => ({ id, rev, title: id, ...extra });
  let store: Store;
  beforeEach(() => {
    store = openStore(':memory:');
    store.putScouts('a', [scout]);
  });
  afterEach(() => store.close());

  const states = (now = 1000) =>
    Object.fromEntries(store.board('a', 'quest-board', now)!.items.map((entry) => [entry.id, entry.state]));
  const record = (items: ScoutItem[], now: number) => store.recordScoutRun('a', 'quest-board', run(), items, now);

  it('keeps each Kingdom’s list of Scouts, replacing it on each report', () => {
    store.putScouts('b', [{ id: 'mail', error: 'scout.json: bad' }]);
    expect(store.scouts('a', 0).map((entry) => entry.id)).toEqual(['quest-board']);
    store.putScouts('a', [{ id: 'other', manifest }]);
    expect(store.scouts('a', 0).map((entry) => entry.id)).toEqual(['other']);
    expect(store.scouts('b', 0)).toMatchObject([{ id: 'mail', error: 'scout.json: bad', fresh: 0 }]);
  });

  it('shows a first run’s items as new, with when they were first seen', () => {
    const board = record([item('x'), item('y')], 100);
    expect(board?.items).toMatchObject([
      { id: 'x', state: 'new', firstSeen: 100, changedAt: 100 },
      { id: 'y', state: 'new', firstSeen: 100, changedAt: 100 },
    ]);
    expect(board?.runs).toHaveLength(1);
    expect(store.scouts('a', 100)).toMatchObject([{ id: 'quest-board', fresh: 2, lastRun: board!.runs[0] }]);
  });

  it('takes a resent run once', () => {
    const same = run();
    expect(store.recordScoutRun('a', 'quest-board', same, [item('x')], 100)).toBeDefined();
    store.changeBoardItems('a', 'quest-board', { ids: ['x'], state: 'done' }, 150);
    expect(store.recordScoutRun('a', 'quest-board', same, [item('x', '2')], 200)).toBeUndefined();
    expect(states()).toEqual({ x: 'done' });
    expect(store.board('a', 'quest-board', 200)!.runs).toHaveLength(1);
  });

  it('records a failed run and leaves the Board as it was', () => {
    record([item('x')], 100);
    const board = store.recordScoutRun(
      'a',
      'quest-board',
      run({ outcome: 'failed', reason: 'exit 1' }),
      undefined,
      200,
    );
    expect(board?.items.map((entry) => entry.id)).toEqual(['x']);
    expect(board?.runs.map((entry) => entry.outcome)).toEqual(['failed', 'succeeded']);
    expect(store.scouts('a', 200)[0]!.lastRun?.outcome).toBe('failed');
  });

  it('brings an item back as new when its rev changes, whatever you did with it', () => {
    record([item('seen'), item('done'), item('dismissed'), item('snoozed'), item('same')], 100);
    store.changeBoardItems('a', 'quest-board', { ids: ['seen', 'same'], state: 'seen' }, 110);
    store.changeBoardItems('a', 'quest-board', { ids: ['done'], state: 'done' }, 110);
    store.changeBoardItems('a', 'quest-board', { ids: ['dismissed'], state: 'dismissed' }, 110);
    store.changeBoardItems('a', 'quest-board', { ids: ['snoozed'], state: 'snoozed', until: 99_999 }, 110);
    const board = record(
      [
        item('seen', '2'),
        item('done', '2'),
        item('dismissed', '2'),
        item('snoozed', '2'),
        item('same', '1', { title: 'renamed' }),
      ],
      200,
    );
    expect(states()).toEqual({ seen: 'new', done: 'new', dismissed: 'new', snoozed: 'new', same: 'seen' });
    const same = board!.items.find((entry) => entry.id === 'same')!;
    expect(same).toMatchObject({ title: 'renamed', changedAt: 100 });
    expect(board!.items.find((entry) => entry.id === 'done')).toMatchObject({ changedAt: 200, firstSeen: 100 });
    expect(board!.items.find((entry) => entry.id === 'snoozed')?.until).toBeUndefined();
  });

  it('marks an item gone when the list leaves it out, and keeps what you did when it comes back unchanged', () => {
    record([item('x'), item('y')], 100);
    store.changeBoardItems('a', 'quest-board', { ids: ['x'], state: 'done' }, 110);
    const gone = record([item('y')], 200);
    expect(gone!.items.find((entry) => entry.id === 'x')).toMatchObject({ state: 'done', goneAt: 200 });
    const back = record([item('x'), item('y')], 300);
    const x = back!.items.find((entry) => entry.id === 'x')!;
    expect(x.state).toBe('done');
    expect(x.goneAt).toBeUndefined();
  });

  it('counts only new items still in the list as fresh', () => {
    record([item('x'), item('y'), item('z')], 100);
    store.changeBoardItems('a', 'quest-board', { ids: ['y'], state: 'seen' }, 110);
    record([item('x'), item('y')], 200);
    expect(store.scouts('a', 200)[0]!.fresh).toBe(1);
  });

  it('marks only new items seen, so looking never undoes done', () => {
    record([item('x'), item('y')], 100);
    store.changeBoardItems('a', 'quest-board', { ids: ['y'], state: 'done' }, 110);
    const changed = store.changeBoardItems('a', 'quest-board', { ids: ['x', 'y', 'nope'], state: 'seen' }, 120);
    expect(changed.map((entry) => [entry.id, entry.state])).toEqual([['x', 'seen']]);
    expect(states()).toEqual({ x: 'seen', y: 'done' });
  });

  it('can put any item back to new, and a snooze reads as new once it runs out', () => {
    record([item('x'), item('y')], 100);
    store.changeBoardItems('a', 'quest-board', { ids: ['x'], state: 'done' }, 110);
    store.changeBoardItems('a', 'quest-board', { ids: ['x'], state: 'new' }, 120);
    store.changeBoardItems('a', 'quest-board', { ids: ['y'], state: 'snoozed', until: 500 }, 120);
    expect(states(499)).toEqual({ x: 'new', y: 'snoozed' });
    expect(store.board('a', 'quest-board', 499)!.items.find((entry) => entry.id === 'y')?.until).toBe(500);
    expect(states(500)).toEqual({ x: 'new', y: 'new' });
    expect(store.scouts('a', 500)[0]!.fresh).toBe(2);
    expect(store.changeBoardItems('a', 'quest-board', { ids: ['y'], state: 'seen' }, 600)).toMatchObject([
      { id: 'y', state: 'seen' },
    ]);
  });

  it('keeps a Board’s recent runs and recently gone items, and lets older ones go', () => {
    for (let n = 0; n < SCOUT_RUNS_KEPT + 5; n++) {
      store.recordScoutRun('a', 'quest-board', run({ startedAt: n, outcome: 'skipped' }), undefined, n);
    }
    record([item('old')], 1000);
    expect(record([], 2000)!.items).toMatchObject([{ id: 'old', goneAt: 2000 }]);
    expect(record([], 2000 + GONE_ITEMS_KEPT_MS)!.items).toHaveLength(1);
    const board = record([], 2001 + GONE_ITEMS_KEPT_MS);
    expect(board!.items).toEqual([]);
    expect(board!.runs).toHaveLength(SCOUT_RUNS_SHOWN);
  });

  it('leaves the Board alone for a run older than one it already took, such as a late resend', () => {
    store.recordScoutRun('a', 'quest-board', run({ startedAt: 2000 }), [item('x', '2'), item('y')], 2100);
    store.changeBoardItems('a', 'quest-board', { ids: ['x'], state: 'done' }, 2200);
    const late = store.recordScoutRun('a', 'quest-board', run({ startedAt: 1000 }), [item('x', '1')], 2300);
    expect(late?.runs).toHaveLength(2);
    expect(states()).toEqual({ x: 'done', y: 'new' });
    expect(late!.items.find((entry) => entry.id === 'x')?.rev).toBe('2');
  });

  it('keeps runs apart per Kingdom, even with one id', () => {
    store.putScouts('b', [scout]);
    const same = run();
    expect(store.recordScoutRun('a', 'quest-board', same, [item('x')], 100)).toBeDefined();
    expect(store.recordScoutRun('b', 'quest-board', same, [item('y')], 100)?.items).toMatchObject([{ id: 'y' }]);
  });

  it('lets old gone items go on failed runs too, so a Scout that stopped working doesn’t keep them', () => {
    record([item('old')], 1000);
    record([], 2000);
    const board = store.recordScoutRun(
      'a',
      'quest-board',
      run({ outcome: 'failed' }),
      undefined,
      2001 + GONE_ITEMS_KEPT_MS,
    );
    expect(board!.items).toEqual([]);
  });

  it('has no Board for a Scout its Kingdom never listed', () => {
    expect(store.board('a', 'nope', 0)).toBeUndefined();
    expect(store.board('b', 'quest-board', 0)).toBeUndefined();
  });

  it('keeps items and runs of a Scout taken off the list, so a folder moved away for a moment loses nothing', () => {
    record([item('x')], 100);
    store.changeBoardItems('a', 'quest-board', { ids: ['x'], state: 'done' }, 110);
    store.putScouts('a', []);
    expect(store.board('a', 'quest-board', 200)).toBeUndefined();
    store.putScouts('a', [scout]);
    expect(states()).toEqual({ x: 'done' });
  });

  it('forgets a Kingdom’s Scouts, runs and items with the Kingdom', () => {
    record([item('x')], 100);
    store.putScouts('b', [scout]);
    store.recordScoutRun('b', 'quest-board', run(), [item('x')], 100);
    store.forgetNode('a');
    store.putScouts('a', [scout]);
    expect(store.board('a', 'quest-board', 200)).toEqual({ scout: 'quest-board', runs: [], items: [] });
    expect(store.board('b', 'quest-board', 200)!.items).toHaveLength(1);
  });
});

describe('Patrols', () => {
  const manifest: PatrolManifest = {
    name: 'Nightly backup check',
    schedule: { cron: '30 3 * * *', timezone: 'UTC' },
    script: { command: ['./check.sh'] },
  };
  const patrol: Patrol = { id: 'backup-check', manifest, failures: 0 };
  let runs = 0;
  const run = (extra: Partial<PatrolRun> = {}): PatrolRun => ({
    id: `00000000-0000-4000-8000-${String(++runs).padStart(12, '0')}`,
    startedAt: runs,
    trigger: 'schedule',
    outcome: 'running',
    ...extra,
  });
  let store: Store;
  beforeEach(() => {
    store = openStore(':memory:');
    store.putPatrols('a', [patrol]);
  });
  afterEach(() => store.close());

  it('keeps each Kingdom’s list of Patrols, replacing it on each report', () => {
    store.putPatrols('b', [{ id: 'sweep', error: 'patrol.json: bad' }]);
    store.putPatrols('a', [{ id: 'other', manifest }, patrol]);
    expect(store.patrols('a').map((entry) => entry.id)).toEqual(['other', 'backup-check']);
    expect(store.patrols('b')).toEqual([{ id: 'sweep', error: 'patrol.json: bad' }]);
    expect(store.hasPatrol('a', 'other')).toBe(true);
    expect(store.hasPatrol('b', 'other')).toBe(false);
  });

  it('updates a run in place when it comes back, and lists it as the Patrol’s latest', () => {
    const out = run();
    expect(store.recordPatrolRun('a', 'backup-check', out)).toEqual([out]);
    const back = { ...out, finishedAt: 9, outcome: 'failed', exitCode: 2, stderr: 'disk full' };
    expect(store.recordPatrolRun('a', 'backup-check', back)).toEqual([back]);
    expect(store.patrols('a')).toEqual([{ ...patrol, lastRun: back }]);
  });

  it('lists runs newest first and keeps only the most recent', () => {
    for (let n = 0; n < PATROL_RUNS_KEPT + 5; n++) store.recordPatrolRun('a', 'backup-check', run());
    const shown = store.patrolRuns('a', 'backup-check')!;
    expect(shown).toHaveLength(PATROL_RUNS_SHOWN);
    expect(shown[0]!.startedAt).toBeGreaterThan(shown[1]!.startedAt);
    store.putPatrols('a', [patrol]);
    const kept = store.patrolRuns('a', 'backup-check', PATROL_RUNS_KEPT + 5)!;
    expect(kept).toHaveLength(PATROL_RUNS_KEPT);
    expect(Math.min(...kept.map((kept) => kept.startedAt))).toBe(runs - PATROL_RUNS_KEPT + 1);
  });

  it('marks a run done and not done again, and keeps the mark when the Kingdom reports the run again', () => {
    const back = run({ finishedAt: 3, outcome: 'finished', summary: 'Nothing to update.' });
    store.recordPatrolRun('a', 'backup-check', back);
    expect(store.markPatrolRun('a', 'backup-check', back.id, true, 50)).toEqual([{ ...back, doneAt: 50 }]);
    // Resent after a reconnect: the hub's own mark stays, and a Kingdom can't set one.
    expect(store.recordPatrolRun('a', 'backup-check', { ...back, doneAt: 1 } as PatrolRun)).toEqual([
      { ...back, doneAt: 50 },
    ]);
    // The list's latest run carries the mark too, for a Board whose runs haven't loaded.
    expect(store.patrols('a')[0]!.lastRun).toEqual({ ...back, doneAt: 50 });
    expect(store.markPatrolRun('a', 'backup-check', back.id, false, 60)).toEqual([back]);
    expect(store.patrolRuns('a', 'backup-check')![0]).not.toHaveProperty('doneAt');
  });

  it('won’t mark a run still out, whose outcome isn’t known yet', () => {
    const out = run();
    store.recordPatrolRun('a', 'backup-check', out);
    expect(store.markPatrolRun('a', 'backup-check', out.id, true, 50)).toBe('out');
    expect(store.markPatrolRun('a', 'backup-check', out.id, false, 50)).toEqual([out]);
  });

  it('marks only a run of the Patrol it names, on a Kingdom that lists it', () => {
    const other: Patrol = { ...patrol, id: 'other' };
    store.putPatrols('a', [patrol, other]);
    const first = run();
    store.recordPatrolRun('a', 'backup-check', first);
    expect(store.markPatrolRun('a', 'other', first.id, true, 50)).toBeUndefined();
    expect(store.markPatrolRun('a', 'backup-check', '00000000-0000-4000-8000-999999999999', true, 50)).toBeUndefined();
    expect(store.markPatrolRun('b', 'backup-check', first.id, true, 50)).toBeUndefined();
    expect(store.patrolRuns('a', 'backup-check')).toEqual([first]);
  });

  it('keeps a run under the Patrol it was first reported under', () => {
    const other: Patrol = { ...patrol, id: 'other' };
    store.putPatrols('a', [patrol, other]);
    const first = run();
    store.recordPatrolRun('a', 'backup-check', first);
    store.recordPatrolRun('a', 'other', { ...first, outcome: 'finished' });
    expect(store.patrolRuns('a', 'other')).toEqual([]);
    expect(store.patrolRuns('a', 'backup-check')).toEqual([first]);
  });

  it('has no runs for a Patrol its Kingdom doesn’t list, and keeps them in case it comes back', () => {
    store.recordPatrolRun('a', 'backup-check', run());
    store.putPatrols('a', []);
    expect(store.patrolRuns('a', 'backup-check')).toBeUndefined();
    store.putPatrols('a', [patrol]);
    expect(store.patrolRuns('a', 'backup-check')).toHaveLength(1);
  });

  it('forgets a Kingdom’s Patrols and runs with the Kingdom', () => {
    store.recordPatrolRun('a', 'backup-check', run());
    store.putPatrols('b', [patrol]);
    store.recordPatrolRun('b', 'backup-check', run());
    store.forgetNode('a');
    expect(store.patrols('a')).toEqual([]);
    store.putPatrols('a', [patrol]);
    expect(store.patrolRuns('a', 'backup-check')).toEqual([]);
    expect(store.patrolRuns('b', 'backup-check')).toHaveLength(1);
  });
});

describe('Errands (#288)', () => {
  const node = 'node-a';
  const project = '/r/lantern';
  const left = (id: string, extra: Record<string, unknown> = {}) => ({
    node,
    id,
    session: randomUUID(),
    seq: 3,
    ts: 100,
    project,
    title: 'Check the lamp oil',
    body: 'Before the next trip.',
    ...extra,
  });
  let store: Store;
  beforeEach(() => {
    store = openStore(':memory:');
  });
  afterEach(() => {
    store.close();
  });

  it('works out an Errand’s project from a Quest’s folder', () => {
    expect(errandProject('/r/lantern')).toBe('/r/lantern');
    expect(errandProject('/r/lantern/.worktrees/abcd1234', '/r/lantern')).toBe('/r/lantern');
    expect(errandProject('/r/lantern/.worktrees/abcd1234')).toBe('/r/lantern');
    expect(errandProject('C:\\r\\lantern\\.worktrees\\abcd1234')).toBe('C:\\r\\lantern');
    expect(errandProject('/r/lantern/.worktrees/notours')).toBe('/r/lantern/.worktrees/notours');
  });

  it('keeps an Errand a Quest left, once', () => {
    const one = left(randomUUID());
    store.recordErrandLeft(one);
    store.recordErrandLeft(one);
    expect(store.errands(node)).toEqual([
      {
        id: one.id,
        session: one.session,
        seq: 3,
        project,
        title: one.title,
        body: one.body,
        state: 'open',
        by: 'quest',
        created: 100,
        updated: 100,
      },
    ]);
  });

  it('adds one by hand, with or without a project', () => {
    const made = store.addErrand(node, { title: 'Renew the certificate', body: '' }, 200);
    expect(made).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      title: 'Renew the certificate',
      body: '',
      state: 'open',
      by: 'you',
      created: 200,
      updated: 200,
    });
    const scoped = store.addErrand(node, { title: 'Sweep', body: 'x', project }, 201);
    expect(scoped.project).toBe(project);
    expect(store.errands(node)).toHaveLength(2);
  });

  it('lists a Kingdom’s own, newest first', () => {
    const first = store.addErrand(node, { title: 'first', body: '' }, 1);
    const second = store.addErrand(node, { title: 'second', body: '' }, 2);
    store.addErrand('node-b', { title: 'other', body: '' }, 3);
    expect(store.errands(node).map((e) => e.id)).toEqual([second.id, first.id]);
  });

  it('edits title and body, and says when', () => {
    const made = store.addErrand(node, { title: 'old', body: 'old' }, 100);
    expect(store.editErrand(node, made.id, { title: 'new', body: 'newer' }, 300)).toEqual({
      ...made,
      title: 'new',
      body: 'newer',
      updated: 300,
    });
    expect(store.editErrand(node, randomUUID(), { title: 'x', body: '' }, 300)).toBeUndefined();
    expect(store.editErrand('node-b', made.id, { title: 'x', body: '' }, 300)).toBeUndefined();
  });

  it('ticks, dismisses and reopens, keeping when it closed', () => {
    const made = store.addErrand(node, { title: 't', body: '' }, 100);
    expect(store.setErrandState(node, made.id, 'done', 400)).toMatchObject({
      state: 'done',
      closed: 400,
      updated: 400,
    });
    expect(store.setErrandState(node, made.id, 'dismissed', 500)).toMatchObject({
      state: 'dismissed',
      closed: 500,
      updated: 500,
    });
    const reopened = store.setErrandState(node, made.id, 'open', 600);
    expect(reopened).toMatchObject({ state: 'open', updated: 600 });
    expect(reopened).not.toHaveProperty('closed');
    expect(store.setErrandState('node-b', made.id, 'done', 700)).toBeUndefined();
  });

  it('counts open Errands per Kingdom', () => {
    store.addErrand(node, { title: 'a', body: '' }, 1);
    store.addErrand(node, { title: 'b', body: '' }, 2);
    const done = store.addErrand(node, { title: 'c', body: '' }, 3);
    store.setErrandState(node, done.id, 'done', 4);
    const other = store.addErrand('node-b', { title: 'd', body: '' }, 5);
    store.setErrandState('node-b', other.id, 'dismissed', 6);
    expect(store.openErrandCounts()).toEqual({ 'node-a': 2 });
  });

  it('deletes closed ones 30 days after they closed, and says whose', () => {
    const old = store.addErrand(node, { title: 'old', body: '' }, 0);
    store.setErrandState(node, old.id, 'done', 0);
    const recent = store.addErrand(node, { title: 'recent', body: '' }, 0);
    store.setErrandState(node, recent.id, 'dismissed', ERRANDS_KEPT_MS - 1);
    const open = store.addErrand(node, { title: 'open', body: '' }, 0);
    expect(store.purgeErrands(ERRANDS_KEPT_MS)).toEqual([node]);
    expect(
      store
        .errands(node)
        .map((e) => e.id)
        .sort(),
    ).toEqual([open.id, recent.id].sort());
    expect(store.purgeErrands(ERRANDS_KEPT_MS)).toEqual([]);
  });

  it('forgets a Kingdom’s Errands', () => {
    store.addErrand(node, { title: 'a', body: '' }, 1);
    store.addErrand('node-b', { title: 'b', body: '' }, 1);
    store.forgetErrands(node);
    expect(store.errands(node)).toEqual([]);
    expect(store.errands('node-b')).toHaveLength(1);
  });

  it('names the Patrol whose Quest left it', () => {
    const session = randomUUID();
    store.appendEvent(
      makeEnvelope({
        node,
        session,
        seq: 1,
        type: 'session.started',
        payload: { cwd: project, prompt: 'p', label: 'l', patrol: { patrol: 'sweep', run: randomUUID() } },
      }),
    );
    store.recordErrandLeft(left(randomUUID(), { session }));
    expect(store.errands(node)[0]?.patrol).toBe('sweep');
  });
});
