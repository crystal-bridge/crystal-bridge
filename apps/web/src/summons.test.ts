import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { Cast } from '@crystal-bridge/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubClient } from './hub.js';
import { useCircle, withCast } from './summons.js';

const ID = '11111111-1111-4111-8111-111111111111';
const cast = (extra: Partial<Cast> = {}): Cast => ({
  id: ID,
  session: '22222222-2222-4222-8222-222222222222',
  summon: 'render',
  name: 'encode',
  command: 'encode all',
  onFinish: 'notify',
  state: 'running',
  startedAt: 0,
  logTail: '',
  ...extra,
});
const ended = cast({ state: 'succeeded', exitCode: 0, finishedAt: 10 });

/** The hub as `useCircle` sees it: a test delivers frames and brings the socket back. */
function fakeHub() {
  const casts = new Set<(node: string, cast: Cast) => void>();
  const reconnects = new Set<() => void>();
  const hub = {
    onCast(listener: (node: string, cast: Cast) => void) {
      casts.add(listener);
      return () => casts.delete(listener);
    },
    onReconnect(listener: () => void) {
      reconnects.add(listener);
      return () => reconnects.delete(listener);
    },
  } as unknown as HubClient;
  return {
    hub,
    frame: (reported: Cast) => casts.forEach((listener) => listener('forge', reported)),
    reconnect: () => reconnects.forEach((listener) => listener()),
  };
}

/** Each fetch waits until a test answers it, so the order of a reply and a frame is the test's. */
function fakeFetch() {
  const pending: ((casts: Cast[] | undefined) => void)[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise((resolve) =>
          pending.push((casts) =>
            resolve(
              casts
                ? { ok: true, json: async () => ({ summons: [{ name: 'render' }], casts }) }
                : { ok: false, json: async () => ({}) },
            ),
          ),
        ),
    ),
  );
  return pending;
}

describe('withCast', () => {
  it('replaces a Cast’s older self', () => {
    expect(withCast([cast({ logTail: 'old' })], cast({ logTail: 'new' }))).toEqual([cast({ logTail: 'new' })]);
  });

  it('won’t let a late running report undo an end', () => {
    expect(withCast([ended], cast())).toEqual([ended]);
  });
});

describe('useCircle', () => {
  let pending: ReturnType<typeof fakeFetch>;
  beforeEach(() => {
    pending = fakeFetch();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const answer = (index: number, casts: Cast[] | undefined) =>
    act(async () => {
      pending[index]!(casts);
    });

  it('reads the hub’s record again when the socket comes back, so a Cast that ended meanwhile shows it', async () => {
    const { hub, reconnect } = fakeHub();
    const { result } = renderHook(() => useCircle(hub, 'forge'));
    await answer(0, [cast()]);
    await waitFor(() => expect(result.current.casts).toEqual([cast()]));

    act(() => reconnect());
    await answer(1, [ended]);
    await waitFor(() => expect(result.current.casts).toEqual([ended]));
  });

  it('keeps a frame that arrives while the record is on its way', async () => {
    const { hub, frame } = fakeHub();
    const { result } = renderHook(() => useCircle(hub, 'forge'));
    act(() => frame(ended));
    await answer(0, [cast()]);
    await waitFor(() => expect(result.current.summons).toEqual([{ name: 'render' }]));
    expect(result.current.casts).toEqual([ended]);
  });

  it('keeps a newer log from a frame over an older record', async () => {
    const { hub, frame } = fakeHub();
    const { result } = renderHook(() => useCircle(hub, 'forge'));
    act(() => frame(cast({ logTail: 'newer' })));
    await answer(0, [cast({ logTail: 'older' })]);
    await waitFor(() => expect(result.current.summons).toEqual([{ name: 'render' }]));
    expect(result.current.casts).toEqual([cast({ logTail: 'newer' })]);
  });

  it('won’t let an earlier record land after a later one', async () => {
    const { hub, reconnect } = fakeHub();
    const { result } = renderHook(() => useCircle(hub, 'forge'));
    act(() => reconnect());
    await answer(1, [ended]);
    await waitFor(() => expect(result.current.casts).toEqual([ended]));
    await answer(0, [cast()]);
    expect(result.current.casts).toEqual([ended]);
  });

  it('keeps what it knows when the hub can’t answer', async () => {
    const { hub, reconnect } = fakeHub();
    const { result } = renderHook(() => useCircle(hub, 'forge'));
    await answer(0, [cast()]);
    await waitFor(() => expect(result.current.casts).toEqual([cast()]));
    act(() => reconnect());
    await answer(1, undefined);
    expect(result.current.casts).toEqual([cast()]);
  });
});
