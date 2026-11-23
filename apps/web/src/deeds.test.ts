import type { Deed, Envelope } from '@crystal-bridge/protocol';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dayLabel,
  deedDays,
  deedProjects,
  finishedTurnSinceClosing,
  PAGE_DAYS,
  questStanding,
  railLook,
  useCloseDeeds,
  useDeeds,
} from './deeds.js';
import { errandTone } from './errands.js';
import type { DeedsFrame, HubClient } from './hub.js';

// A Wednesday, local noon.
const NOW = new Date(2026, 10, 18, 12, 0, 0).getTime();
const midnight = (daysBack: number) => new Date(2026, 10, 18 - daysBack).getTime();
const SESSION = '11111111-1111-4111-8111-111111111111';

const deed = (id: string, at: number, extra: Partial<Deed> = {}): Deed => ({ id, kind: 'turn', at, ...extra });

function fakeHub() {
  const listeners = new Set<(frame: DeedsFrame) => void>();
  const reconnects = new Set<() => void>();
  const hub = {
    onDeeds(listener: (frame: DeedsFrame) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onReconnect(listener: () => void) {
      reconnects.add(listener);
      return () => reconnects.delete(listener);
    },
  } as unknown as HubClient;
  return {
    hub,
    frame: (node: string, deeds: Deed[], cleared?: true) =>
      listeners.forEach((listener) => listener({ kind: 'deeds', node, deeds, ...(cleared ? { cleared } : {}) })),
    reconnect: () => reconnects.forEach((listener) => listener()),
  };
}

function fakeFetch() {
  const pending: { url: string; answer: (body: unknown, status?: number) => void }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string) =>
        new Promise((resolve) =>
          pending.push({
            url,
            answer: (body, status = 200) =>
              resolve({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }),
          }),
        ),
    ),
  );
  return pending;
}

describe('Deeds data', () => {
  let pending: ReturnType<typeof fakeFetch>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    pending = fakeFetch();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('useDeeds reads the last 7 local days, then takes its frames', async () => {
    const { hub, frame, reconnect } = fakeHub();
    const { result } = renderHook(() => useDeeds(hub, 'forge'));
    expect(result.current).toMatchObject({ deeds: [], loaded: false });
    const after = midnight(PAGE_DAYS - 1);
    expect(pending[0]?.url).toBe(`/api/nodes/forge/deeds?after=${after}`);
    await act(async () => pending[0]?.answer({ deeds: [deed('turn:a:1', NOW - 1000)] }));
    expect(result.current.loaded).toBe(true);
    expect(result.current.after).toBe(after);

    act(() => frame('forge', [deed('turn:a:2', NOW - 500)]));
    expect(result.current.deeds.map((d) => d.id)).toEqual(['turn:a:2', 'turn:a:1']);
    act(() => frame('forge', [deed('turn:a:1', NOW - 1000, { files: 3 })]));
    expect(result.current.deeds.map((d) => d.id)).toEqual(['turn:a:2', 'turn:a:1']);
    expect(result.current.deeds[1]?.files).toBe(3);
    act(() => frame('other', [deed('turn:b:1', NOW)]));
    expect(result.current.deeds).toHaveLength(2);

    // Older than the loaded days: ignored, unless the row is already held.
    act(() => frame('forge', [deed('turn:a:0', after - 1)]));
    expect(result.current.deeds).toHaveLength(2);

    act(() => reconnect());
    expect(pending).toHaveLength(2);
  });

  it('useDeeds keeps the rows of a frame that landed before the first read', async () => {
    const { hub, frame } = fakeHub();
    const { result } = renderHook(() => useDeeds(hub, 'forge'));
    act(() => frame('forge', [deed('turn:a:2', NOW, { files: 9 })]));
    await act(async () =>
      pending[0]?.answer({ deeds: [deed('turn:a:2', NOW, { files: 1 }), deed('turn:a:1', NOW - 5)] }),
    );
    expect(result.current.deeds.map((d) => d.id)).toEqual(['turn:a:2', 'turn:a:1']);
    expect(result.current.deeds[0]?.files).toBe(9);
  });

  it('follows `more` before it counts a window whole, and keeps `older` from the last page', async () => {
    const { hub } = fakeHub();
    const { result } = renderHook(() => useDeeds(hub, 'forge'));
    const after = midnight(PAGE_DAYS - 1);
    await act(async () =>
      pending[0]?.answer({ deeds: [deed('turn:a:3', NOW)], more: { at: NOW, id: 'turn:a:3' }, older: 1 }),
    );
    expect(result.current.loaded).toBe(false);
    expect(pending[1]?.url).toBe(`/api/nodes/forge/deeds?after=${after}&beforeAt=${NOW}&beforeId=turn%3Aa%3A3`);
    await act(async () => pending[1]?.answer({ deeds: [deed('turn:a:2', NOW - 1)], older: midnight(20) }));
    expect(result.current.deeds.map((d) => d.id)).toEqual(['turn:a:3', 'turn:a:2']);
    expect(result.current.loaded).toBe(true);
    expect(result.current.older).toBe(midnight(20));
  });

  it('loadOlder reads the 7 local days ending at the newest older row', async () => {
    const { hub } = fakeHub();
    const { result } = renderHook(() => useDeeds(hub, 'forge'));
    const after = midnight(PAGE_DAYS - 1);
    act(() => result.current.loadOlder());
    expect(pending).toHaveLength(1);
    await act(async () => pending[0]?.answer({ deeds: [deed('turn:a:1', NOW)], older: midnight(20) + 3600_000 }));
    act(() => result.current.loadOlder());
    const earlier = midnight(26);
    expect(pending[1]?.url).toBe(`/api/nodes/forge/deeds?after=${earlier}&before=${after}`);
    // A full page there follows `more` inside the same window.
    await act(async () =>
      pending[1]?.answer({ deeds: [deed('turn:a:0', midnight(20))], more: { at: midnight(20), id: 'turn:a:0' } }),
    );
    expect(pending[2]?.url).toBe(
      `/api/nodes/forge/deeds?after=${earlier}&before=${after}&beforeAt=${midnight(20)}&beforeId=turn%3Aa%3A0`,
    );
    await act(async () => pending[2]?.answer({ deeds: [deed('turn:a:00', midnight(21))], older: midnight(40) }));
    expect(result.current.deeds.map((d) => d.id)).toEqual(['turn:a:1', 'turn:a:0', 'turn:a:00']);
    expect(result.current.after).toBe(earlier);
    expect(result.current.older).toBe(midnight(40));
    expect(result.current.loadingOlder).toBe(false);

    // With nothing older, it reads nothing.
    await act(async () => {
      result.current.loadOlder();
      pending[3]?.answer({ deeds: [] });
    });
    await act(async () => {});
    expect(result.current.older).toBeUndefined();
    const count = pending.length;
    act(() => result.current.loadOlder());
    expect(pending).toHaveLength(count);
  });

  it('clears an older-days error once a later read of them succeeds', async () => {
    const { hub } = fakeHub();
    const { result } = renderHook(() => useDeeds(hub, 'forge'));
    await act(async () => pending[0]?.answer({ deeds: [deed('turn:a:1', NOW)], older: midnight(20) }));
    act(() => result.current.loadOlder());
    await act(async () => pending[1]?.answer({ error: 'the Kingdom is busy' }, 503));
    expect(result.current.error).toBe('the Kingdom is busy');
    act(() => result.current.loadOlder());
    await act(async () => pending[2]?.answer({ deeds: [deed('turn:a:0', midnight(20))] }));
    expect(result.current.deeds).toHaveLength(2);
    expect(result.current.error).toBeUndefined();
  });

  it('lets go of an older-days read that a reconnect supersedes, even when the new read fails', async () => {
    const { hub, reconnect } = fakeHub();
    const { result } = renderHook(() => useDeeds(hub, 'forge'));
    await act(async () => pending[0]?.answer({ deeds: [deed('turn:a:1', NOW)], older: midnight(20) }));
    act(() => result.current.loadOlder());
    expect(result.current.loadingOlder).toBe(true);
    act(() => reconnect());
    expect(result.current.loadingOlder).toBe(false);
    await act(async () => pending[1]?.answer({ deeds: [deed('turn:a:0', midnight(20))] }));
    await act(async () => pending[2]?.answer({ error: 'down' }, 503));
    expect(result.current.loadingOlder).toBe(false);
    expect(result.current.deeds.map((d) => d.id)).toEqual(['turn:a:1']);
    // Once the read is over, the older days can be asked for again.
    const count = pending.length;
    act(() => result.current.loadOlder());
    expect(pending).toHaveLength(count + 1);
  });

  it('reads no older days while a reconnect reads the newest again', async () => {
    const { hub, reconnect } = fakeHub();
    const { result } = renderHook(() => useDeeds(hub, 'forge'));
    await act(async () => pending[0]?.answer({ deeds: [deed('turn:a:1', NOW)], older: midnight(20) }));
    act(() => reconnect());
    expect(pending).toHaveLength(2);
    act(() => result.current.loadOlder());
    expect(pending).toHaveLength(2);
  });

  it('keeps a reconnect’s read to its own window, not the older days loaded before it', async () => {
    const { hub, frame, reconnect } = fakeHub();
    const { result } = renderHook(() => useDeeds(hub, 'forge'));
    await act(async () => pending[0]?.answer({ deeds: [deed('turn:a:1', NOW)], older: midnight(20) }));
    act(() => result.current.loadOlder());
    await act(async () => pending[1]?.answer({ deeds: [deed('turn:a:0', midnight(20))], older: midnight(40) }));
    expect(result.current.after).toBe(midnight(26));
    act(() => reconnect());
    // Inside the older days loaded, outside the newest 7 the reconnect reads.
    act(() => frame('forge', [deed('turn:b:1', midnight(10))]));
    await act(async () => pending[2]?.answer({ deeds: [deed('turn:a:1', NOW)], older: midnight(20) }));
    expect(result.current.deeds.map((d) => d.id)).toEqual(['turn:a:1']);
  });

  it('says it is reading the newest days again after a reconnect, until that read is over', async () => {
    const { hub, reconnect } = fakeHub();
    const { result } = renderHook(() => useDeeds(hub, 'forge'));
    expect(result.current.reloading).toBeFalsy();
    await act(async () => pending[0]?.answer({ deeds: [deed('turn:a:1', NOW)], older: midnight(20) }));
    act(() => reconnect());
    expect(result.current.reloading).toBe(true);
    await act(async () => pending[1]?.answer({ deeds: [deed('turn:a:1', NOW)], older: midnight(20) }));
    expect(result.current.reloading).toBeFalsy();
    act(() => reconnect());
    await act(async () => pending[2]?.answer({ error: 'down' }, 503));
    expect(result.current.reloading).toBeFalsy();
  });

  it('leaves out a frame’s rows from before the window while the first read is on its way', async () => {
    const { hub, frame } = fakeHub();
    const { result } = renderHook(() => useDeeds(hub, 'forge'));
    const after = midnight(PAGE_DAYS - 1);
    act(() => frame('forge', [deed('turn:a:0', after - 1), deed('turn:a:2', NOW)]));
    await act(async () => pending[0]?.answer({ deeds: [deed('turn:a:1', NOW - 5)], older: after - 1 }));
    expect(result.current.deeds.map((d) => d.id)).toEqual(['turn:a:2', 'turn:a:1']);
  });

  it('reads one project’s rows when given one', async () => {
    const { hub, frame } = fakeHub();
    const { result } = renderHook(() => useDeeds(hub, 'forge', '/r/acme/lantern'));
    expect(pending[0]?.url).toBe(`/api/nodes/forge/deeds?after=${midnight(6)}&project=%2Fr%2Facme%2Flantern`);
    await act(async () => pending[0]?.answer({ deeds: [] }));
    act(() => frame('forge', [deed('turn:a:1', NOW, { project: '/r/other' }), deed('turn:a:2', NOW)]));
    expect(result.current.deeds).toEqual([]);
    act(() => frame('forge', [deed('turn:a:3', NOW, { project: '/r/acme/lantern' })]));
    expect(result.current.deeds.map((d) => d.id)).toEqual(['turn:a:3']);
  });

  it('drops every row when a frame says the Kingdom was cleared', async () => {
    const { hub, frame } = fakeHub();
    const { result } = renderHook(() => useDeeds(hub, 'forge'));
    await act(async () => pending[0]?.answer({ deeds: [deed('turn:a:1', NOW)], older: 1 }));
    act(() => frame('other', [], true));
    expect(result.current.deeds).toHaveLength(1);
    act(() => frame('forge', [], true));
    expect(result.current.deeds).toEqual([]);
    expect(result.current.older).toBeUndefined();
    expect(result.current.loaded).toBe(true);
  });

  it('says why the feed couldn’t be read', async () => {
    const { hub } = fakeHub();
    const { result } = renderHook(() => useDeeds(hub, 'forge'));
    await act(async () => pending[0]?.answer({ error: 'the Kingdom is busy' }, 503));
    expect(result.current).toMatchObject({ deeds: [], loaded: false, error: 'the Kingdom is busy' });
  });

  it('keeps the choice at Close per device', () => {
    const first = renderHook(() => useCloseDeeds());
    expect(first.result.current[0]).toBe(true);
    act(() => first.result.current[1](false));
    expect(first.result.current[0]).toBe(false);
    expect(renderHook(() => useCloseDeeds()).result.current[0]).toBe(false);
    expect(localStorage.getItem('crystal-bridge.close-deeds')).toBe('off');
    localStorage.clear();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    act(() => first.result.current[1](false));
    expect(first.result.current[0]).toBe(false);
    expect(renderHook(() => useCloseDeeds()).result.current[0]).toBe(false);
    vi.restoreAllMocks();
    act(() => first.result.current[1](true));
  });

  it('finishedTurnSinceClosing tells whether a turn ended after the latest call at Close', () => {
    const at = (type: string, seq: number): Envelope => ({
      node: 'forge',
      session: SESSION,
      seq,
      ts: seq,
      type,
      payload: {},
    });
    expect(finishedTurnSinceClosing([])).toBe(false);
    expect(finishedTurnSinceClosing([at('session.started', 0)])).toBe(false);
    const finished = [at('session.started', 0), at('turn.finished', 1)];
    expect(finishedTurnSinceClosing(finished)).toBe(true);
    expect(finishedTurnSinceClosing([...finished, at('deeds.closing', 2)])).toBe(false);
    expect(finishedTurnSinceClosing([...finished, at('deeds.closing', 2), at('turn.finished', 3)])).toBe(true);
  });
});

const LANTERN = '/r/acme/lantern';
const QUARRY = '/r/acme/quarry';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PR = 'https://github.com/acme/lantern/pull/7';
const at = (daysBack: number, hour: number) => new Date(2026, 10, 18 - daysBack, hour).getTime();

describe('the feed folded by day and Quest', () => {
  it('groups by local day, newest first, labelled, leaving empty days out', () => {
    const rows = [
      deed('turn:a:1', at(0, 9), { session: SESSION }),
      deed('turn:a:2', at(1, 9), { session: SESSION }),
      deed('turn:a:3', at(4, 9), { session: SESSION }),
    ];
    const days = deedDays(rows, NOW);
    expect(days.map((d) => d.day)).toEqual([midnight(0), midnight(1), midnight(4)]);
    expect(days.slice(0, 2).map((d) => d.label)).toEqual(['Today', 'Yesterday']);
    expect(days[2]!.label).toBe(dayLabel(midnight(4), NOW));
    expect(days[2]!.label).not.toMatch(/Today|Yesterday/);
    expect(deedDays([], NOW)).toEqual([]);
  });

  it("folds each Quest's rows on a day into one entry", () => {
    const rows = [
      deed('turn:a:1', at(0, 9), { session: SESSION, project: LANTERN, files: 3, costUsd: 0.5, durationMs: 600_000 }),
      deed('turn:a:2', at(0, 10), {
        session: SESSION,
        project: LANTERN,
        files: 4,
        prs: [PR],
        costUsd: 0.5,
        durationMs: 600_000,
      }),
      deed('turn:a:3', at(0, 11), { session: SESSION, project: LANTERN, files: 5, costUsd: 0.5, durationMs: 600_000 }),
      deed('turn:a:4', at(0, 11) + 60_000, { session: SESSION, project: LANTERN, costUsd: 0.34, durationMs: 720_000 }),
      deed('deed:x', at(0, 11) + 120_000, { session: SESSION, project: LANTERN, kind: 'deed', text: 'Fixed it' }),
      deed('turn:a:0', at(1, 9), { session: SESSION, project: LANTERN }),
      deed('turn:b:1', at(0, 8), { session: OTHER, project: QUARRY }),
    ];
    const [today, yesterday] = deedDays(rows, NOW);
    expect(today!.entries.map((e) => e.key)).toHaveLength(2);
    const entry = today!.entries[0]!;
    if (entry.kind !== 'quest') throw new Error('expected a quest entry');
    expect(entry.session).toBe(SESSION);
    expect(entry.project).toBe(LANTERN);
    expect(entry.turns.map((t) => t.id)).toEqual(['turn:a:4', 'turn:a:3', 'turn:a:2', 'turn:a:1']);
    expect(entry.deeds.map((d) => d.id)).toEqual(['deed:x']);
    expect(entry.at).toBe(at(0, 11) + 120_000);
    expect(entry.totals).toEqual({ turns: 4, files: 12, prs: [PR], costUsd: 1.84, durationMs: 2_520_000 });
    expect(yesterday!.entries).toHaveLength(1);
    expect(yesterday!.entries[0]!.kind).toBe('quest');
    expect(yesterday!.entries[0]!.key).not.toBe(entry.key);
  });

  it('shows no counts where no tally came, never zeros', () => {
    const none = deedDays([deed('turn:a:1', at(0, 9), { session: SESSION })], NOW)[0]!.entries[0]!;
    const zero = deedDays([deed('turn:a:1', at(0, 9), { session: SESSION, files: 0 })], NOW)[0]!.entries[0]!;
    if (none.kind !== 'quest' || zero.kind !== 'quest') throw new Error('expected quests');
    expect(none.totals.files).toBeUndefined();
    expect(zero.totals.files).toBe(0);
  });

  it('puts the call at Close on the day it ran', () => {
    const rows = [
      deed('turn:a:1', at(1, 9), { session: SESSION }),
      deed('close:a:2', at(0, 9), { session: SESSION, kind: 'close', outcome: 'recorded', costUsd: 0.08 }),
      deed('closing:1', at(0, 9) + 1, { session: SESSION, kind: 'closing', text: 'Shipped' }),
    ];
    const entry = deedDays(rows, NOW)[0]!.entries[0]!;
    if (entry.kind !== 'quest') throw new Error('expected a quest entry');
    expect(entry.turns).toEqual([]);
    expect(entry.close?.id).toBe('close:a:2');
    expect(entry.totals.costUsd).toBe(0.08);
    expect(entry.deeds.map((d) => d.kind)).toEqual(['closing']);
  });

  it('takes a reply from the latest finished turn', () => {
    const rows = [
      deed('turn:a:1', at(0, 9), { session: SESSION, text: 'old' }),
      deed('turn:a:2', at(0, 10), { session: SESSION }),
      deed('turn:a:3', at(0, 11), { session: SESSION, text: 'new' }),
      deed('turn:a:4', at(0, 12), { session: SESSION }),
    ];
    const entry = deedDays(rows, NOW)[0]!.entries[0]!;
    if (entry.kind !== 'quest') throw new Error('expected a quest entry');
    expect(entry.latestReply).toBe('new');
  });

  it('keeps a script run as an entry of its own', () => {
    const row = deed('run:r1', at(0, 7), { kind: 'patrol', patrol: 'nightly' });
    const entry = deedDays([row], NOW)[0]!.entries[0]!;
    expect(entry).toMatchObject({ kind: 'run', row });
  });

  it("groups days in the viewer's time zone across a clock change", () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    try {
      // 2026-11-01 is the 25-hour day: 00:30 and 23:30 local are both on it; 00:30 on the 2nd is not.
      const local = (day: number, h: number, m: number) => new Date(2026, 10, day, h, m).getTime();
      const rows = [
        deed('turn:a:1', local(1, 0, 30), { session: SESSION }),
        deed('turn:a:2', local(1, 23, 30), { session: SESSION }),
        deed('turn:a:3', local(2, 0, 30), { session: SESSION }),
      ];
      const days = deedDays(rows, local(2, 12, 0));
      expect(days.map((d) => d.entries.length)).toEqual([1, 1]);
      const first = days[1]!.entries[0]!;
      if (first.kind !== 'quest') throw new Error('expected a quest entry');
      expect(first.totals.turns).toBe(2);
      expect(days.map((d) => d.label)[0]).toBe('Today');
      expect(days.map((d) => d.label)[1]).toBe('Yesterday');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('questStanding', () => {
  const close = (outcome: string): Deed => deed('close:a:1', 1, { kind: 'close', outcome });
  it('says how a Quest stands', () => {
    expect(questStanding({ status: 'running' }, undefined)).toEqual({ kind: 'open' });
    expect(questStanding({ status: 'closed' }, close('recorded'))).toEqual({ kind: 'deeds' });
    expect(questStanding({ status: 'closed' }, close('timeout'))).toEqual({ kind: 'closed', why: 'timeout' });
    expect(questStanding({ status: 'closed' }, undefined)).toEqual({ kind: 'closed', why: 'skipped' });
    expect(questStanding(undefined, undefined)).toEqual({ kind: 'closed', why: 'skipped' });
  });
});

describe('deedProjects', () => {
  it('lists each project once, the most used first, leaving script runs out', () => {
    const rows = [
      deed('turn:a:1', at(0, 9), { session: SESSION, project: QUARRY }),
      deed('turn:b:1', at(0, 9), { session: OTHER, project: LANTERN }),
      deed('turn:b:2', at(1, 9), { session: OTHER, project: LANTERN }),
      deed('turn:b:3', at(1, 10), { session: OTHER, project: LANTERN }),
      deed('run:1', at(0, 9), { kind: 'patrol' }),
    ];
    const projects = deedProjects(rows);
    expect(projects.map((p) => [p.project, p.name, p.count])).toEqual([
      [LANTERN, 'lantern', 2],
      [QUARRY, 'quarry', 1],
    ]);
    expect(projects[0]!.tone).toBe(errandTone(LANTERN));
  });
});

describe('railLook', () => {
  const entry = (rows: Deed[]) => {
    const found = deedDays(rows, NOW)[0]!.entries[0]!;
    return found;
  };
  it('picks a look for each kind of entry, never blue', () => {
    const turn = deed('turn:a:1', at(0, 9), { session: SESSION });
    const looks = {
      closing: railLook(entry([turn, deed('c:1', at(0, 9), { session: SESSION, kind: 'closing' })])),
      turn: railLook(entry([turn, deed('d:1', at(0, 9), { session: SESSION, kind: 'deed' })])),
      patrol: railLook(entry([deed('turn:p:1', at(0, 9), { session: SESSION, patrol: 'nightly' })])),
      turns: railLook(entry([turn])),
      run: railLook(entry([deed('run:1', at(0, 9), { kind: 'patrol' })])),
    };
    expect(looks.closing.icon).toBe('deedClosing');
    expect(looks.turn.icon).toBe('quillInk');
    expect(looks.patrol.icon).toBe('errandPatrol');
    expect(looks.run.icon).toBe('errandPatrol');
    expect(looks.turns.icon).toBe('deedTurns');
    expect(looks.closing.tile).toContain('amber');
    expect(looks.patrol.tile).toContain('stone');
    for (const look of Object.values(looks)) {
      expect(look.tile).not.toContain('blue-');
      expect(look.label.themed).toBeTruthy();
    }
  });
  it('shows a failed script run in red', () => {
    const failed = entry([deed('run:1', at(0, 9), { kind: 'patrol', outcome: 'failed' })]);
    expect(railLook(failed).tile).toContain('red');
  });
});
