import type { Errand, ListedPatrol } from '@crystal-bridge/protocol';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addErrand,
  closedOnes,
  dayGroups,
  ERRAND_TONES,
  editErrand,
  errandSource,
  errandsBySession,
  errandTone,
  openOnes,
  projectGroups,
  setErrandState,
  useErrandCounts,
  useErrandLayout,
  useErrands,
} from './errands.js';
import { UNREACHABLE } from './api.js';
import type { ErrandsFrame, HubClient } from './hub.js';
import { w } from './theme/words.js';

const ID = '44444444-4444-4444-8444-444444444444';
const errand = (extra: Partial<Errand> = {}): Errand => ({
  id: ID,
  title: 'Renew the certificate',
  body: '',
  state: 'open',
  by: 'you',
  created: 1,
  updated: 1,
  ...extra,
});

function fakeHub() {
  const listeners = new Set<(frame: ErrandsFrame) => void>();
  const reconnects = new Set<() => void>();
  const hub = {
    onErrands(listener: (frame: ErrandsFrame) => void) {
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
    frame: (frame: ErrandsFrame) => listeners.forEach((listener) => listener(frame)),
    reconnect: () => reconnects.forEach((listener) => listener()),
  };
}

/** Each fetch waits until a test answers it, so the order of a reply and a frame is the test's. */
function fakeFetch() {
  const pending: { url: string; init?: RequestInit; answer: (body: unknown, status?: number) => void }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string, init?: RequestInit) =>
        new Promise((resolve) =>
          pending.push({
            url,
            ...(init ? { init } : {}),
            answer: (body, status = 200) =>
              resolve({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }),
          }),
        ),
    ),
  );
  return pending;
}

describe('Errands data', () => {
  let pending: ReturnType<typeof fakeFetch>;
  beforeEach(() => {
    pending = fakeFetch();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("useErrands reads a Kingdom's Errands, then takes its frames", async () => {
    const { hub, frame, reconnect } = fakeHub();
    const { result } = renderHook(() => useErrands(hub, 'forge'));
    expect(result.current).toEqual({ errands: [], loaded: false });
    expect(pending[0]?.url).toBe('/api/nodes/forge/errands');
    await act(async () => pending[0]?.answer({ errands: [errand()] }));
    expect(result.current).toEqual({ errands: [errand()], loaded: true });

    act(() => frame({ kind: 'errands', node: 'forge', errands: [errand({ title: 'New' })] }));
    expect(result.current.errands[0]?.title).toBe('New');
    act(() => frame({ kind: 'errands', node: 'other', errands: [] }));
    expect(result.current.errands).toHaveLength(1);

    act(() => reconnect());
    expect(pending).toHaveLength(2);
    act(() => frame({ kind: 'errands', node: 'forge', errands: [errand({ title: 'Newest' })] }));
    await act(async () => pending[1]?.answer({ errands: [errand({ title: 'Stale' })] }));
    expect(result.current.errands[0]?.title).toBe('Newest');
  });

  it('useErrands lets a frame that lands before the first list win', async () => {
    const { hub, frame } = fakeHub();
    const { result } = renderHook(() => useErrands(hub, 'forge'));
    act(() => frame({ kind: 'errands', node: 'forge', errands: [errand({ title: 'From the frame' })] }));
    expect(result.current).toEqual({ errands: [errand({ title: 'From the frame' })], loaded: true });
    await act(async () => pending[0]?.answer({ errands: [errand({ title: 'From the list' })] }));
    expect(result.current.errands[0]?.title).toBe('From the frame');
  });

  it('useErrands drops a late list for the Kingdom it left', async () => {
    const { hub } = fakeHub();
    const { result, rerender } = renderHook(({ node }) => useErrands(hub, node), {
      initialProps: { node: 'forge' },
    });
    rerender({ node: 'keep' });
    expect(pending.map((p) => p.url)).toEqual(['/api/nodes/forge/errands', '/api/nodes/keep/errands']);
    await act(async () => pending[0]?.answer({ errands: [errand({ title: 'Forge’s' })] }));
    expect(result.current).toEqual({ errands: [], loaded: false });
    await act(async () => pending[1]?.answer({ errands: [errand({ title: 'Keep’s' })] }));
    expect(result.current.errands[0]?.title).toBe('Keep’s');
  });

  it('useErrands says why a list failed, stays unloaded, and reads it again on reconnect', async () => {
    const { hub, reconnect } = fakeHub();
    const { result } = renderHook(() => useErrands(hub, 'forge'));
    await act(async () => pending[0]?.answer({ error: 'the Kingdom is busy' }, 503));
    expect(result.current).toEqual({ errands: [], loaded: false, error: 'the Kingdom is busy' });
    act(() => reconnect());
    await act(async () => pending[1]?.answer({ errands: [errand()] }));
    expect(result.current).toEqual({ errands: [errand()], loaded: true });
  });

  it('useErrands says the hub was unreachable when the list never arrived', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    const { hub } = fakeHub();
    const { result } = renderHook(() => useErrands(hub, 'forge'));
    await waitFor(() => expect(result.current.error).toBe(UNREACHABLE));
    expect(result.current.loaded).toBe(false);
  });

  it('useErrands holds nothing without a Kingdom', () => {
    const { hub } = fakeHub();
    const { result } = renderHook(() => useErrands(hub, undefined));
    expect(result.current).toEqual({ errands: [], loaded: false });
    expect(pending).toHaveLength(0);
  });

  it("useErrandCounts reads every Kingdom's open count, then counts each frame's open ones", async () => {
    const { hub, frame } = fakeHub();
    const { result } = renderHook(() => useErrandCounts(hub));
    expect(pending[0]?.url).toBe('/api/errands/counts');
    await act(async () => pending[0]?.answer({ forge: 2, keep: 1 }));
    await waitFor(() => expect(result.current).toEqual({ forge: 2, keep: 1 }));
    act(() =>
      frame({
        kind: 'errands',
        node: 'forge',
        errands: [errand(), errand({ state: 'done' }), errand({ state: 'open' })],
      }),
    );
    expect(result.current).toEqual({ forge: 2, keep: 1 });
    act(() => frame({ kind: 'errands', node: 'keep', errands: [errand({ state: 'dismissed' })] }));
    expect(result.current).toEqual({ forge: 2 });
  });

  it('useErrandCounts lets a frame that lands before the counts win', async () => {
    const { hub, frame } = fakeHub();
    const { result } = renderHook(() => useErrandCounts(hub));
    act(() => frame({ kind: 'errands', node: 'forge', errands: [errand()] }));
    expect(result.current).toEqual({ forge: 1 });
    // The list was read before the frame: its 3 for forge is older.
    await act(async () => pending[0]?.answer({ forge: 3, keep: 2 }));
    expect(result.current).toEqual({ forge: 1, keep: 2 });
  });

  it('useErrandCounts reads the counts again on reconnect', async () => {
    const { hub, frame, reconnect } = fakeHub();
    const { result } = renderHook(() => useErrandCounts(hub));
    await act(async () => pending[0]?.answer({ forge: 2 }));
    act(() => frame({ kind: 'errands', node: 'keep', errands: [errand()] }));
    expect(result.current).toEqual({ forge: 2, keep: 1 });
    act(() => reconnect());
    expect(pending[1]?.url).toBe('/api/errands/counts');
    // Frames heard before the reconnect are no newer than the fresh read, so it replaces them.
    await act(async () => pending[1]?.answer({ forge: 4 }));
    expect(result.current).toEqual({ forge: 4 });
  });

  it('addErrand, editErrand and setErrandState send their bodies, and throw the hub’s refusal', async () => {
    const added = addErrand('forge', { title: 'Renew', body: '' });
    expect(pending[0]?.url).toBe('/api/nodes/forge/errands');
    expect(pending[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(pending[0]?.init?.body))).toEqual({ title: 'Renew', body: '' });
    pending[0]?.answer({ errand: errand() }, 201);
    expect(await added).toEqual(errand());

    const edited = editErrand('forge', ID, { title: 'T', body: 'B' });
    expect(pending[1]?.url).toBe(`/api/nodes/forge/errands/${ID}`);
    expect(pending[1]?.init?.method).toBe('PUT');
    expect(JSON.parse(String(pending[1]?.init?.body))).toEqual({ title: 'T', body: 'B' });
    pending[1]?.answer({ errand: errand({ title: 'T' }) });
    expect((await edited).title).toBe('T');

    const ticked = setErrandState('forge', ID, 'done');
    expect(pending[2]?.url).toBe(`/api/nodes/forge/errands/${ID}/state`);
    expect(pending[2]?.init?.method).toBe('PUT');
    expect(JSON.parse(String(pending[2]?.init?.body))).toEqual({ state: 'done' });
    pending[2]?.answer({ errand: errand({ state: 'done' }) });
    expect((await ticked).state).toBe('done');

    const refused = addErrand('forge', { title: 'x', body: '' });
    pending[3]?.answer({ error: 'too many open Errands' }, 409);
    await expect(refused).rejects.toThrow('too many open Errands');
  });
});

const LANTERN = '/r/acme/lantern';
const QUARRY = '/r/acme/quarry';
const mk = (n: number, extra: Partial<Errand> = {}) => errand({ id: `id-${n}`, created: n, updated: n, ...extra });

describe('errandsBySession', () => {
  it('counts every Errand of a Quest, any state', () => {
    const S = '55555555-5555-4555-8555-555555555555';
    const counts = errandsBySession([
      errand({ session: S }),
      errand({ session: S, state: 'done' }),
      errand({ session: S, state: 'dismissed' }),
      errand({ session: '66666666-6666-4666-8666-666666666666' }),
      errand(),
    ]);
    expect(counts).toEqual({ [S]: 3, '66666666-6666-4666-8666-666666666666': 1 });
  });
});

describe('Errand sorting', () => {
  it('splits by state, closed ones newest closed first', () => {
    const list = [
      mk(1),
      mk(2, { state: 'done', closed: 10 }),
      mk(3, { state: 'dismissed', closed: 20 }),
      mk(4, { state: 'done', closed: 5 }),
    ];
    expect(openOnes(list).map((e) => e.id)).toEqual(['id-1']);
    expect(closedOnes(list).map((e) => e.id)).toEqual(['id-3', 'id-2', 'id-4']);
  });

  it('groups by project, newest first, no project last, shares summing to 1', () => {
    const open = [
      mk(5, { project: QUARRY }),
      mk(9),
      mk(7, { project: LANTERN }),
      mk(6, { project: QUARRY }),
      mk(2, { project: LANTERN }),
    ];
    const groups = projectGroups(open);
    expect(groups.map((g) => g.project)).toEqual([LANTERN, QUARRY, undefined]);
    expect(groups.map((g) => g.name)).toEqual(['lantern', 'quarry', 'No project']);
    expect(groups[0]!.errands.map((e) => e.id)).toEqual(['id-7', 'id-2']);
    expect(groups[0]!.share).toBeCloseTo(0.4);
    expect(groups.reduce((sum, g) => sum + g.share, 0)).toBeCloseTo(1);
    expect(groups[2]!.tone).toBe('slate');
    expect(projectGroups([])).toEqual([]);
  });

  it('groups by local day, leaving empty days out', () => {
    const now = new Date(2026, 10, 21, 15, 0).getTime();
    const at = (day: number, hour: number) => new Date(2026, 10, day, hour).getTime();
    const open = [
      mk(1, { created: at(21, 9) }),
      mk(2, { created: at(21, 14) }),
      mk(3, { created: at(20, 23) }),
      mk(4, { created: at(10, 8) }),
    ];
    const groups = dayGroups(open, now);
    expect(groups.map((g) => g.day)).toEqual(['today', 'yesterday', 'earlier']);
    expect(groups[0]!.errands.map((e) => e.id)).toEqual(['id-2', 'id-1']);
    expect(dayGroups([open[3]!], now).map((g) => g.day)).toEqual(['earlier']);
  });
});

describe('errandSource', () => {
  const sessions = [{ id: 'S1', label: 'The Siege', plainLabel: 'Fix the test' }];
  const patrols = [{ id: 'dawn', manifest: { name: 'Dawn audit' } }] as unknown as ListedPatrol[];
  it('names a Quest, a Patrol, or a hand', () => {
    expect(errandSource(mk(1, { session: 'S1' }), { sessions, patrols })).toEqual({
      kind: 'quest',
      session: 'S1',
      label: 'The Siege',
    });
    expect(errandSource(mk(1, { session: 'S1', patrol: 'dawn' }), { sessions, patrols })).toEqual({
      kind: 'patrol',
      session: 'S1',
      name: 'Dawn audit',
    });
    expect(errandSource(mk(1, { session: 'S1', patrol: 'gone' }), { sessions, patrols })).toMatchObject({
      kind: 'patrol',
      name: 'gone',
    });
    expect(errandSource(mk(1), { sessions, patrols })).toEqual({ kind: 'hand' });
  });
  it('still links a Quest the list lacks, under the theme word', () => {
    expect(errandSource(mk(1, { session: 'ZZ' }), { sessions, patrols })).toEqual({
      kind: 'quest',
      session: 'ZZ',
      label: w('quest'),
    });
  });
});

describe('errandTone', () => {
  it('is stable, never blue or sky, slate for none', () => {
    expect(errandTone(LANTERN)).toBe(errandTone(LANTERN));
    const tones = new Set(Array.from({ length: 200 }, (_, i) => errandTone(`/r/acme/p${i}`)));
    expect(tones.has('blue' as never)).toBe(false);
    expect(tones.has('sky' as never)).toBe(false);
    expect(tones.size).toBeGreaterThan(4);
    expect(errandTone(undefined)).toBe('slate');
    for (const tone of [...tones, 'slate'] as const) {
      expect(Object.keys(ERRAND_TONES[tone]).sort()).toEqual(['bar', 'chip', 'dot', 'stripe', 'text', 'wash']);
    }
  });

  it('spreads a few nearby projects across colours', () => {
    const few = ['/r/acme/lantern', '/r/acme/quarry', '/r/tidepool/kelp', '/r/acme/atlas', '/r/acme/forge'];
    expect(new Set(few.map(errandTone)).size).toBeGreaterThanOrEqual(4);
  });
});

describe('useErrandLayout', () => {
  beforeEach(() => localStorage.clear());
  it('starts on the checklist, switches to cards, and a second hook sees it', () => {
    const first = renderHook(() => useErrandLayout());
    expect(first.result.current[0]).toBe('checklist');
    act(() => first.result.current[1]('cards'));
    expect(first.result.current[0]).toBe('cards');
    expect(renderHook(() => useErrandLayout()).result.current[0]).toBe('cards');
    expect(localStorage.getItem('crystal-bridge.errands-layout')).toBe('cards');
  });
  it('holds the choice for the page when storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    const hook = renderHook(() => useErrandLayout());
    act(() => hook.result.current[1]('checklist'));
    act(() => hook.result.current[1]('cards'));
    expect(hook.result.current[0]).toBe('cards');
  });
});
