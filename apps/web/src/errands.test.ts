import type { Errand } from '@crystal-bridge/protocol';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addErrand, editErrand, setErrandState, useErrandCounts, useErrands } from './errands.js';
import type { ErrandsFrame, HubClient } from './hub.js';

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
