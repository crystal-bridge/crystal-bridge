import type { Deed, Envelope } from '@crystal-bridge/protocol';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { finishedTurnSinceClosing, PAGE_DAYS, useCloseDeeds, useDeeds } from './deeds.js';
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
