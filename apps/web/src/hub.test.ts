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

  it('says when the socket comes back, not when it first opens', () => {
    const { hub, socket } = connected();
    const back = vi.fn();
    const stop = hub.onReconnect(back);
    socket.dispatchEvent(new Event('close'));
    vi.runOnlyPendingTimers();
    expect(back).not.toHaveBeenCalled();
    FakeSocket.last.open();
    expect(back).toHaveBeenCalledTimes(1);

    stop();
    FakeSocket.last.dispatchEvent(new Event('close'));
    vi.runOnlyPendingTimers();
    FakeSocket.last.open();
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('takes a replay batch in one change, reports progress, and is synced only at the marker', () => {
    const { hub, socket, changes } = connected();
    hub.subscribe(SESSION);
    expect(socket.sent.at(-1)).toEqual({ kind: 'subscribe', session: SESSION, fromSeq: 0 });
    expect(hub.progress(SESSION)).toEqual({ received: 0, total: null, synced: false });

    socket.deliver({ kind: 'events', session: SESSION, events: [0, 1, 2].map(envelope), total: 5 });
    vi.runOnlyPendingTimers();
    expect(changes).toHaveBeenCalledTimes(1);
    expect(hub.events(SESSION).map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(hub.progress(SESSION)).toEqual({ received: 3, total: 5, synced: false });

    socket.deliver({ kind: 'events', session: SESSION, events: [3, 4].map(envelope), total: 5 });
    socket.deliver({ kind: 'synced', session: SESSION, seq: 6 });
    expect(hub.progress(SESSION)).toEqual({ received: 5, total: 5, synced: true });
    // The marker's seq counts as seen even though seq 5 and 6 (left-out fragments) never arrived.
    expect(hub.seenSeq(SESSION)).toBe(6);
  });

  it('skips what it can’t read in a replay batch, and keeps the rest', () => {
    const { hub, socket } = connected();
    hub.subscribe(SESSION);
    const unreadable = { ...envelope(1), seq: 'one' };
    socket.deliver({ kind: 'events', session: SESSION, events: [envelope(0), unreadable, envelope(2)], total: 3 });
    socket.deliver({ kind: 'synced', session: SESSION, seq: 2 });
    expect(hub.events(SESSION).map((e) => e.seq)).toEqual([0, 2]);
    expect(hub.progress(SESSION).synced).toBe(true);
    expect(hub.seenSeq(SESSION)).toBe(2);
  });

  it('keeps events of a type it doesn’t know, in a replay and live', () => {
    const { hub, socket } = connected();
    hub.subscribe(SESSION);
    const newer = { ...envelope(1), type: 'quest.sparkled' };
    socket.deliver({ kind: 'events', session: SESSION, events: [envelope(0), newer], total: 2 });
    socket.deliver({ kind: 'event', event: { ...newer, seq: 2 } });
    expect(hub.events(SESSION).map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('still drops a replay frame whose outside it can’t read, and a live event it can’t read', () => {
    const { hub, socket } = connected();
    hub.subscribe(SESSION);
    socket.deliver({ kind: 'events', session: SESSION, events: 'none', total: 1 });
    socket.deliver({ kind: 'events', session: 'not-a-session', events: [envelope(0)], total: 1 });
    socket.deliver({ kind: 'event', event: { ...envelope(0), seq: 'one' } });
    expect(hub.events(SESSION)).toEqual([]);
    expect(hub.seenSeq(SESSION)).toBe(-1);
  });

  it('coalesces a burst of live events into one change', () => {
    const { hub, socket, changes } = connected();
    hub.subscribe(SESSION);
    socket.deliver({ kind: 'synced', session: SESSION, seq: -1 });
    changes.mockClear();

    for (let seq = 0; seq < 20; seq++) socket.deliver({ kind: 'event', event: envelope(seq) });
    expect(changes).not.toHaveBeenCalled();
    vi.runOnlyPendingTimers();
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

describe('HubClient outbox', () => {
  const STOP = { type: 'session.interrupt', session: SESSION } as const;
  const KEYS = { type: 'session.keys', session: SESSION, keys: 'y' } as const;
  const ANSWER = { type: 'permission.answer', session: SESSION, requestId: 'r', behavior: 'allow' } as const;
  const SEND = { type: 'session.send', session: SESSION, text: 'and then' } as const;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function disconnected() {
    const hub = new HubClient('ws://hub/client');
    FakeSocket.last.open();
    FakeSocket.last.dispatchEvent(new Event('close'));
    return hub;
  }
  function reconnect() {
    vi.advanceTimersByTime(600);
    FakeSocket.last.open();
    return FakeSocket.last.sent.filter((frame) => (frame as { kind: string }).kind === 'command');
  }

  it('drops what only made sense at the time on a reconnect, and says what was not sent', () => {
    const hub = disconnected();
    const errors = vi.fn();
    hub.onError(errors);
    hub.send(STOP);
    hub.send(KEYS);
    hub.send(ANSWER);
    expect(reconnect()).toEqual([]);
    expect(errors).toHaveBeenCalledOnce();
    const [message, notSent] = errors.mock.calls[0]!;
    expect(message).toMatch(/Stop/);
    expect(message).toMatch(/terminal/);
    expect(message).toMatch(/approval/);
    expect(notSent).toBe(true);
  });

  it('still delivers a queued follow-up, in order, and stays quiet about it', () => {
    const hub = disconnected();
    const errors = vi.fn();
    hub.onError(errors);
    hub.send(SEND);
    hub.send({ ...SEND, text: 'second' });
    expect(reconnect()).toEqual([
      { kind: 'command', command: SEND },
      { kind: 'command', command: { ...SEND, text: 'second' } },
    ]);
    expect(errors).not.toHaveBeenCalled();
  });

  it('counts what is queued, and tells listeners when that changes', () => {
    const hub = disconnected();
    const changes = vi.fn();
    hub.onChange(changes);
    expect(hub.queued).toBe(0);
    hub.send(SEND);
    expect(hub.queued).toBe(1);
    expect(changes).toHaveBeenCalled();
    changes.mockClear();
    reconnect();
    expect(hub.queued).toBe(0);
    expect(changes).toHaveBeenCalled();
  });

  it('sends straight away on an open link', () => {
    const hub = new HubClient('ws://hub/client');
    FakeSocket.last.open();
    hub.send(STOP);
    expect(hub.queued).toBe(0);
    expect(FakeSocket.last.sent).toContainEqual({ kind: 'command', command: STOP });
  });
});

describe('HubClient heartbeat', () => {
  const pings = (socket: FakeSocket) => socket.sent.filter((frame) => (frame as { kind: string }).kind === 'ping');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function answering() {
    const hub = new HubClient('ws://hub/client');
    const socket = FakeSocket.last;
    socket.open();
    expect(pings(socket)).toHaveLength(1);
    socket.deliver({ kind: 'pong' });
    return { hub, socket };
  }

  it('keeps a link that answers', () => {
    const { hub, socket } = answering();
    for (let beat = 0; beat < 10; beat++) {
      vi.advanceTimersByTime(25_000);
      socket.deliver({ kind: 'pong' });
    }
    expect(hub.status).toBe('open');
    expect(FakeSocket.last).toBe(socket);
    expect(pings(socket).length).toBeGreaterThan(5);
  });

  it('counts any frame as an answer', () => {
    const { hub, socket } = answering();
    vi.advanceTimersByTime(25_000);
    socket.deliver({ kind: 'error', message: 'still here' });
    vi.advanceTimersByTime(20_000);
    expect(hub.status).toBe('open');
  });

  it('gives up on a half-open socket, shows it, and reconnects from where it was', () => {
    const { hub, socket } = answering();
    hub.subscribe(SESSION);
    socket.deliver({ kind: 'synced', session: SESSION, seq: 3 });
    const close = vi.spyOn(socket, 'close');
    vi.advanceTimersByTime(25_000 + 15_000);
    expect(close).toHaveBeenCalled();
    expect(hub.status).not.toBe('open');
    vi.advanceTimersByTime(600);
    expect(FakeSocket.last).not.toBe(socket);
    FakeSocket.last.open();
    expect(FakeSocket.last.sent).toContainEqual({ kind: 'subscribe', session: SESSION, fromSeq: 4 });
  });

  it('leaves alone a late close from the socket it gave up on', () => {
    const { hub, socket } = answering();
    vi.advanceTimersByTime(25_000 + 15_000 + 600);
    const next = FakeSocket.last;
    next.open();
    socket.dispatchEvent(new Event('close'));
    expect(hub.status).toBe('open');
    vi.advanceTimersByTime(600);
    expect(FakeSocket.last).toBe(next);
  });

  it('never drops the link to an older hub, which does not answer pings, and stops asking', () => {
    const hub = new HubClient('ws://hub/client');
    const socket = FakeSocket.last;
    socket.open();
    vi.advanceTimersByTime(600_000);
    expect(hub.status).toBe('open');
    expect(FakeSocket.last).toBe(socket);
    expect(pings(socket)).toHaveLength(1);
  });

  it('checks the link at once when the tab comes back or the network changes', () => {
    const { hub, socket } = answering();
    window.dispatchEvent(new Event('online'));
    expect(pings(socket)).toHaveLength(2);
    socket.deliver({ kind: 'pong' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(pings(socket)).toHaveLength(3);
    vi.advanceTimersByTime(15_000);
    expect(hub.status).not.toBe('open');
  });

  it('tries again at once, instead of waiting out the backoff, when the tab comes back', () => {
    const { socket } = answering();
    socket.dispatchEvent(new Event('close'));
    expect(FakeSocket.last).toBe(socket);
    window.dispatchEvent(new Event('online'));
    expect(FakeSocket.last).not.toBe(socket);
  });

  it('stops everything when closed', () => {
    const { hub, socket } = answering();
    hub.close();
    socket.dispatchEvent(new Event('close'));
    window.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(600_000);
    expect(FakeSocket.last).toBe(socket);
    expect(pings(socket)).toHaveLength(1);
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
