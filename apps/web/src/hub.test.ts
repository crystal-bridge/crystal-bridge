import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '@crystal-bridge/protocol';
import { HubClient } from './hub.js';

const SESSION = '11111111-1111-4111-8111-111111111111';

/** A stand-in for the browser WebSocket: records what the client sends and lets a test deliver frames. */
class FakeSocket extends EventTarget {
  static OPEN = 1;
  static last: FakeSocket;
  readyState = 0;
  sent: unknown[] = [];
  constructor(readonly url: string) {
    super();
    FakeSocket.last = this;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
  open() {
    this.readyState = FakeSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }
  deliver(frame: unknown) {
    this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(frame) }));
  }
}

function envelope(seq: number): Envelope {
  return { node: 'n', session: SESSION, seq, ts: seq, type: 'user.message', payload: { text: `m${seq}` } };
}

describe('HubClient replay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function connected() {
    const hub = new HubClient('ws://hub/client');
    FakeSocket.last.open();
    const changes = vi.fn();
    hub.onChange(changes);
    return { hub, socket: FakeSocket.last, changes };
  }

  it('takes a replay batch in one change, reports progress, and is synced only at the marker', () => {
    const { hub, socket, changes } = connected();
    hub.subscribe(SESSION);
    expect(socket.sent.at(-1)).toEqual({ kind: 'subscribe', session: SESSION, fromSeq: 0 });
    expect(hub.progress(SESSION)).toEqual({ received: 0, total: null, synced: false });

    socket.deliver({ kind: 'events', session: SESSION, events: [0, 1, 2].map(envelope), total: 5 });
    vi.runAllTimers();
    expect(changes).toHaveBeenCalledTimes(1);
    expect(hub.events(SESSION).map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(hub.progress(SESSION)).toEqual({ received: 3, total: 5, synced: false });

    socket.deliver({ kind: 'events', session: SESSION, events: [3, 4].map(envelope), total: 5 });
    socket.deliver({ kind: 'synced', session: SESSION, seq: 6 });
    expect(hub.progress(SESSION)).toEqual({ received: 5, total: 5, synced: true });
    // The marker's seq counts as seen even though seq 5 and 6 (left-out fragments) never arrived.
    expect(hub.seenSeq(SESSION)).toBe(6);
  });

  it('coalesces a burst of live events into one change', () => {
    const { hub, socket, changes } = connected();
    hub.subscribe(SESSION);
    socket.deliver({ kind: 'synced', session: SESSION, seq: -1 });
    changes.mockClear();

    for (let seq = 0; seq < 20; seq++) socket.deliver({ kind: 'event', event: envelope(seq) });
    expect(changes).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(changes).toHaveBeenCalledTimes(1);
    expect(hub.events(SESSION)).toHaveLength(20);
  });

  it('re-subscribes after a reconnect from the last seq seen, and stays synced', () => {
    const { hub, socket } = connected();
    hub.subscribe(SESSION);
    socket.deliver({ kind: 'events', session: SESSION, events: [envelope(0)], total: 1 });
    socket.deliver({ kind: 'synced', session: SESSION, seq: 3 });

    socket.dispatchEvent(new Event('close'));
    vi.advanceTimersByTime(600);
    FakeSocket.last.open();
    expect(FakeSocket.last.sent).toContainEqual({ kind: 'subscribe', session: SESSION, fromSeq: 4 });
    expect(hub.progress(SESSION).synced).toBe(true);
  });
});

describe('HubClient file viewer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('asks the hub for a file and resolves with the answer to that request', async () => {
    const hub = new HubClient('ws://hub/client');
    FakeSocket.last.open();
    const reading = hub.readFile(SESSION, 'docs/README.md');
    const asked = FakeSocket.last.sent.at(-1) as { kind: string; command: { requestId: string } };
    expect(asked).toMatchObject({
      kind: 'command',
      command: { type: 'file.read', session: SESSION, path: 'docs/README.md' },
    });
    FakeSocket.last.deliver({ kind: 'file', requestId: asked.command.requestId, ok: true, content: '# Hi', size: 4 });
    await expect(reading).resolves.toMatchObject({ ok: true, content: '# Hi' });
  });

  it('answers at once when not connected, and gives up when the hub never answers', async () => {
    const hub = new HubClient('ws://hub/client');
    await expect(hub.readFile(SESSION, 'a.md')).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/connect/),
    });
    FakeSocket.last.open();
    const reading = hub.readFile(SESSION, 'a.md');
    vi.advanceTimersByTime(30_000);
    await expect(reading).resolves.toMatchObject({ ok: false });
  });
});
