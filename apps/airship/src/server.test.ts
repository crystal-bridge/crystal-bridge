import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ClientMessage } from '@crystal-bridge/protocol';
import type { Attention, Envelope, HubAck, HubToClient, NodeCommand } from '@crystal-bridge/protocol';
import { accessTokens, tailscaleServe } from './auth.js';
import { createFirstRun, type FirstRun } from './first-run.js';
import { buildServer } from './server.js';
import type { NodeRegistry } from './nodes.js';
import { openStore, type SessionRow, type Store } from './store.js';

function makeEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    node: 'node-a',
    session: randomUUID(),
    seq: 0,
    ts: Date.now(),
    type: 'claude.event',
    payload: { engine: 'claude', raw: { type: 'system', subtype: 'init' } },
    ...overrides,
  };
}

function sessionStartedEnvelope(session: string, node: string, overrides: Partial<Envelope> = {}): Envelope {
  return makeEnvelope({
    session,
    node,
    seq: 0,
    type: 'session.started',
    payload: { cwd: '/tmp/work', prompt: 'say hello', label: 'say hello' },
    ...overrides,
  });
}

/** Collects every parsed JSON frame received on a socket, from the moment it's created. */
class FrameRecorder {
  frames: Record<string, unknown>[] = [];

  constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => {
      this.frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
  }

  async waitFor(
    predicate: (frame: Record<string, unknown>) => boolean,
    timeoutMs = 2000,
  ): Promise<Record<string, unknown>> {
    const existing = this.frames.find(predicate);
    if (existing) return existing;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = this.frames.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('timed out waiting for frame');
  }
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function send(socket: WebSocket, data: unknown): void {
  socket.send(JSON.stringify(data));
}

describe('airship server', () => {
  let store: Store;
  let app: import('fastify').FastifyInstance;
  let baseUrl: string;
  let wsUrl: string;
  let sockets: WebSocket[];

  beforeEach(async () => {
    store = openStore(':memory:');
    app = await buildServer({ store, release: 'test-release' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    wsUrl = `ws://127.0.0.1:${address.port}`;
    sockets = [];
  });

  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    await app.close();
    store.close();
  });

  async function connectNode(nodeId: string): Promise<{ socket: WebSocket; frames: FrameRecorder }> {
    const socket = await openSocket(`${wsUrl}/node`);
    sockets.push(socket);
    const frames = new FrameRecorder(socket);
    send(socket, { kind: 'hello', node: nodeId });
    return { socket, frames };
  }

  async function connectClient(): Promise<{ socket: WebSocket; frames: FrameRecorder }> {
    const socket = await openSocket(`${wsUrl}/client`);
    sockets.push(socket);
    const frames = new FrameRecorder(socket);
    return { socket, frames };
  }

  it('closes a node that speaks another protocol version, and accepts one that names none', async () => {
    const socket = await openSocket(`${wsUrl}/node`);
    sockets.push(socket);
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })),
    );
    send(socket, { kind: 'hello', node: 'node-z', protocol: 99 });
    expect(await closed).toEqual({ code: 4006, reason: 'protocol v99 not supported; this hub speaks v1' });

    await connectNode('node-a'); // a hello with no protocol is v1
    const start = Date.now();
    let nodes: string[] = [];
    while (!nodes.includes('node-a') && Date.now() - start < 2000) {
      nodes = (await (await fetch(`${baseUrl}/api/nodes`)).json()) as string[];
    }
    expect(nodes).toEqual(['node-a']);
  });

  it('GET /api/health returns ok, the release, the protocol version and the connected nodes, for monitors', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    expect(await response.json()).toEqual({ ok: true, release: 'test-release', protocol: 1, nodes: [] });
    await connectNode('node-a');
    const start = Date.now();
    let body = { nodes: [] as string[] };
    while (!body.nodes.includes('node-a') && Date.now() - start < 2000)
      body = (await (await fetch(`${baseUrl}/api/health`)).json()) as { nodes: string[] };
    expect(body.nodes).toEqual(['node-a']);
  });

  it('acks a node envelope and stores it', async () => {
    const { socket } = await connectNode('node-a');
    const frames = new FrameRecorder(socket);
    const envelope = makeEnvelope();

    send(socket, envelope);

    const ack = (await frames.waitFor((f) => f.kind === 'ack')) as unknown as HubAck;
    expect(ack).toEqual({ kind: 'ack', session: envelope.session, seq: envelope.seq });
    expect(store.eventsSince(envelope.session, 0)).toEqual([envelope]);
  });

  it('acks a resent duplicate envelope again but does not broadcast it twice', async () => {
    const { socket: nodeSocket } = await connectNode('node-a');
    const nodeFrames = new FrameRecorder(nodeSocket);
    const envelope = makeEnvelope();

    const { socket: clientSocket, frames: clientFrames } = await connectClient();
    send(clientSocket, { kind: 'subscribe', session: envelope.session, fromSeq: 0 });

    send(nodeSocket, envelope);
    await nodeFrames.waitFor((f) => f.kind === 'ack');
    await clientFrames.waitFor((f) => f.kind === 'event');

    send(nodeSocket, envelope); // resend the exact same envelope
    const acks = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 1000) {
        if (nodeFrames.frames.filter((f) => f.kind === 'ack').length >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return nodeFrames.frames.filter((f) => f.kind === 'ack');
    })();
    expect(acks).toHaveLength(2);

    // give any (incorrect) second broadcast a chance to arrive before asserting it didn't
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(clientFrames.frames.filter((f) => f.kind === 'event')).toHaveLength(1);
  });

  it('replays stored events in a batch, says when it is synced, then sends live ones, and keeps other sessions out', async () => {
    const sessionA = randomUUID();
    const sessionB = randomUUID();
    const stored = sessionStartedEnvelope(sessionA, 'node-a');
    store.appendEvent(stored);

    const { socket } = await connectClient();
    const frames = new FrameRecorder(socket);
    send(socket, { kind: 'subscribe', session: sessionA, fromSeq: 0 });

    const replayed = await frames.waitFor((f) => f.kind === 'events');
    expect(replayed).toEqual({ kind: 'events', session: sessionA, events: [stored], total: 1 });
    expect(await frames.waitFor((f) => f.kind === 'synced')).toEqual({ kind: 'synced', session: sessionA, seq: 0 });

    const { socket: nodeSocket } = await connectNode('node-a');
    const live = makeEnvelope({ session: sessionA, node: 'node-a', seq: 1 });
    send(nodeSocket, live);

    const liveFrame = await frames.waitFor(
      (f) => f.kind === 'event' && (f as unknown as { event: Envelope }).event.seq === 1,
    );
    expect((liveFrame as unknown as { event: Envelope }).event).toEqual(live);
    expect(frames.frames.filter((f) => f.kind === 'event')).toHaveLength(1);

    // an event on a different session must never reach this subscriber
    const otherLive = makeEnvelope({ session: sessionB, node: 'node-a', seq: 0 });
    send(nodeSocket, otherLive);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(frames.frames.filter((f) => f.kind === 'event')).toHaveLength(1);
  });

  it('replays a long history in batches of 500, each with the total', async () => {
    const session = randomUUID();
    store.appendEvent(sessionStartedEnvelope(session, 'node-a'));
    for (let seq = 1; seq < 1200; seq++) store.appendEvent(makeEnvelope({ session, node: 'node-a', seq }));

    const { socket, frames } = await connectClient();
    send(socket, { kind: 'subscribe', session, fromSeq: 0 });
    await frames.waitFor((f) => f.kind === 'synced');

    const batches = frames.frames.filter((f) => f.kind === 'events') as unknown as {
      events: Envelope[];
      total: number;
    }[];
    expect(batches.map((b) => b.events.length)).toEqual([500, 500, 200]);
    expect(batches.every((b) => b.total === 1200)).toBe(true);
    expect(batches.flatMap((b) => b.events.map((e) => e.seq))).toEqual([...Array(1200).keys()]);
    expect(frames.frames.at(-1)).toEqual({ kind: 'synced', session, seq: 1199 });
  });

  it('leaves out streaming fragments of finished turns from a replay, but keeps a turn in progress', async () => {
    const session = randomUUID();
    const raw = (type: string) => ({ engine: 'claude', raw: { type } });
    store.appendEvent(sessionStartedEnvelope(session, 'node-a'));
    store.appendEvent(makeEnvelope({ session, node: 'node-a', seq: 1, payload: raw('stream_event') }));
    store.appendEvent(makeEnvelope({ session, node: 'node-a', seq: 2, payload: raw('assistant') }));
    store.appendEvent(makeEnvelope({ session, node: 'node-a', seq: 3, payload: raw('result') }));
    store.appendEvent(makeEnvelope({ session, node: 'node-a', seq: 4, payload: raw('stream_event') }));

    const { socket, frames } = await connectClient();
    send(socket, { kind: 'subscribe', session, fromSeq: 0 });
    const synced = await frames.waitFor((f) => f.kind === 'synced');

    const batch = frames.frames.find((f) => f.kind === 'events') as unknown as { events: Envelope[]; total: number };
    expect(batch.events.map((e) => e.seq)).toEqual([0, 2, 3, 4]);
    expect(batch.total).toBe(4);
    // The true last seq, so a reconnect resumes after the fragment that was left out.
    expect(synced).toEqual({ kind: 'synced', session, seq: 4 });
  });

  it('says synced at once for a session with nothing new to replay', async () => {
    const session = randomUUID();
    store.appendEvent(sessionStartedEnvelope(session, 'node-a'));

    const { socket, frames } = await connectClient();
    send(socket, { kind: 'subscribe', session, fromSeq: 1 });
    expect(await frames.waitFor((f) => f.kind === 'synced')).toEqual({ kind: 'synced', session, seq: 0 });
    send(socket, { kind: 'subscribe', session: randomUUID(), fromSeq: 0 });
    expect(await frames.waitFor((f) => f.kind === 'synced' && f.seq === -1)).toMatchObject({ seq: -1 });
    expect(frames.frames.filter((f) => f.kind === 'events')).toHaveLength(0);
  });

  it('routes session.start by its node field to the connected node', async () => {
    const { socket: nodeSocket } = await connectNode('node-a');
    const nodeFrames = new FrameRecorder(nodeSocket);
    const { socket: clientSocket } = await connectClient();

    const command: NodeCommand = {
      type: 'session.start',
      node: 'node-a',
      session: randomUUID(),
      cwd: '/tmp/work',
      prompt: 'do stuff',
    };
    send(clientSocket, { kind: 'command', command });

    const received = await nodeFrames.waitFor((f) => f.type === 'session.start');
    expect(received).toEqual(command);
  });

  it('sends a fork to its source session-s node and folder, whatever the client said', async () => {
    const { socket: nodeSocket } = await connectNode('node-a');
    const nodeFrames = new FrameRecorder(nodeSocket);
    const { socket: clientSocket, frames: clientFrames } = await connectClient();
    const source = randomUUID();
    store.appendEvent(sessionStartedEnvelope(source, 'node-a'));

    const fork = randomUUID();
    const command = { type: 'session.start', node: 'node-b', session: fork, cwd: '/etc', prompt: 'p', worktree: true };
    send(clientSocket, { kind: 'command', command: { ...command, forkFrom: source } });
    expect(await nodeFrames.waitFor((f) => f.type === 'session.start')).toEqual({
      type: 'session.start',
      node: 'node-a',
      session: fork,
      cwd: '/tmp/work',
      prompt: 'p',
      forkFrom: source,
    });

    send(clientSocket, { kind: 'command', command: { ...command, session: randomUUID(), forkFrom: randomUUID() } });
    expect(await clientFrames.waitFor((f) => f.kind === 'error')).toMatchObject({
      message: expect.stringMatching(/unknown session/),
    });
  });

  it('sends a file.read to the session-s node with the store-s folder, and the answer to the asking client only', async () => {
    const { socket: nodeSocket, frames: nodeFrames } = await connectNode('node-a');
    const { socket: asker, frames: askerFrames } = await connectClient();
    const { frames: otherFrames } = await connectClient();
    const sessionId = randomUUID();
    store.appendEvent(sessionStartedEnvelope(sessionId, 'node-a'));

    const requestId = randomUUID();
    send(asker, {
      kind: 'command',
      command: { type: 'file.read', session: sessionId, requestId, path: 'README.md', cwd: '/etc' },
    });
    expect(await nodeFrames.waitFor((f) => f.type === 'file.read')).toEqual({
      type: 'file.read',
      session: sessionId,
      requestId,
      path: 'README.md',
      cwd: '/tmp/work',
    });

    const reply = { kind: 'file', requestId, ok: true, path: 'README.md', content: '# Hi', size: 4, truncated: false };
    send(nodeSocket, reply);
    expect(await askerFrames.waitFor((f) => f.kind === 'file')).toEqual(reply);
    // Only once: a repeated or late answer for the same request goes nowhere.
    send(nodeSocket, reply);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(askerFrames.frames.filter((f) => f.kind === 'file')).toHaveLength(1);
    expect(otherFrames.frames.some((f) => f.kind === 'file')).toBe(false);
  });

  it('drops a file answer from a node that was not asked, and answers itself when the Kingdom is offline', async () => {
    await connectNode('node-a');
    const { socket: intruder } = await connectNode('node-b');
    const { socket: asker, frames } = await connectClient();
    const sessionId = randomUUID();
    store.appendEvent(sessionStartedEnvelope(sessionId, 'node-a'));
    const requestId = randomUUID();
    send(asker, { kind: 'command', command: { type: 'file.read', session: sessionId, requestId, path: 'a.md' } });
    send(intruder, { kind: 'file', requestId, ok: true, content: 'forged' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(frames.frames.some((f) => f.kind === 'file')).toBe(false);

    const offline = randomUUID();
    store.appendEvent(sessionStartedEnvelope(offline, 'node-c'));
    const offlineRequest = randomUUID();
    send(asker, {
      kind: 'command',
      command: { type: 'file.read', session: offline, requestId: offlineRequest, path: 'a' },
    });
    expect(await frames.waitFor((f) => f.kind === 'file' && f.requestId === offlineRequest)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/offline/),
    });

    const unknown = randomUUID();
    send(asker, {
      kind: 'command',
      command: { type: 'file.read', session: randomUUID(), requestId: unknown, path: 'a' },
    });
    expect(await frames.waitFor((f) => f.kind === 'file' && f.requestId === unknown)).toMatchObject({ ok: false });
  });

  it('routes a non-start command by looking up the session-s node in the store', async () => {
    const { socket: nodeSocket } = await connectNode('node-a');
    const nodeFrames = new FrameRecorder(nodeSocket);
    const { socket: clientSocket } = await connectClient();

    const sessionId = randomUUID();
    store.appendEvent(sessionStartedEnvelope(sessionId, 'node-a'));

    const command: NodeCommand = { type: 'session.send', session: sessionId, text: 'follow up' };
    send(clientSocket, { kind: 'command', command });

    const received = await nodeFrames.waitFor((f) => f.type === 'session.send');
    expect(received).toEqual({ ...command, resume: { cwd: '/tmp/work', nextSeq: 1 } });
  });

  it('fills resume on a session.send from the store, ignoring any resume the client sent', async () => {
    const { socket: nodeSocket } = await connectNode('node-a');
    const nodeFrames = new FrameRecorder(nodeSocket);
    const { socket: clientSocket } = await connectClient();

    const sessionId = randomUUID();
    store.appendEvent(sessionStartedEnvelope(sessionId, 'node-a'));
    store.appendEvent(makeEnvelope({ session: sessionId, node: 'node-a', seq: 7 }));

    send(clientSocket, {
      kind: 'command',
      command: { type: 'session.send', session: sessionId, text: 'hi', resume: { cwd: '/etc', nextSeq: 0 } },
    });

    const received = await nodeFrames.waitFor((f) => f.type === 'session.send');
    expect(received).toEqual({
      type: 'session.send',
      session: sessionId,
      text: 'hi',
      resume: { cwd: '/tmp/work', nextSeq: 8 },
    });
  });

  it('marks running sessions the node no longer holds as idle when it says hello', async () => {
    const [held, orphan] = [randomUUID(), randomUUID()];
    store.appendEvent(sessionStartedEnvelope(held, 'node-a'));
    store.appendEvent(sessionStartedEnvelope(orphan, 'node-a'));

    const { socket } = await openSocket(`${wsUrl}/node`).then((s) => ({ socket: s }));
    sockets.push(socket);
    send(socket, { kind: 'hello', node: 'node-a', sessions: [held] });

    const start = Date.now();
    while (store.getSession(orphan)?.status !== 'idle' && Date.now() - start < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(store.getSession(orphan)?.status).toBe('idle');
    expect(store.getSession(held)?.status).toBe('running');
  });

  it('returns a node-offline error to the client when the target node is not connected', async () => {
    const { socket: clientSocket, frames: clientFrames } = await connectClient();

    const command: NodeCommand = {
      type: 'session.start',
      node: 'ghost-node',
      session: randomUUID(),
      cwd: '/tmp/work',
      prompt: 'do stuff',
    };
    send(clientSocket, { kind: 'command', command });

    const error = (await clientFrames.waitFor((f) => f.kind === 'error')) as unknown as HubToClient;
    expect(error).toEqual({ kind: 'error', message: 'node offline' });
  });

  it('errors a session.start whose session id already exists in the store', async () => {
    const { socket: clientSocket, frames: clientFrames } = await connectClient();
    const sessionId = randomUUID();
    store.appendEvent(sessionStartedEnvelope(sessionId, 'node-a'));

    const command: NodeCommand = {
      type: 'session.start',
      node: 'node-a',
      session: sessionId,
      cwd: '/tmp/work',
      prompt: 'do stuff again',
    };
    send(clientSocket, { kind: 'command', command });

    const error = await clientFrames.waitFor((f) => f.kind === 'error');
    expect(error.kind).toBe('error');
    expect(typeof (error as { message: string }).message).toBe('string');
  });

  it('GET /api/usage returns the latest usage per node', async () => {
    const payload = { windows: [{ id: 'five_hour', label: '5h', usedPct: 9, resetsAt: null, status: 'allowed' }] };
    store.appendEvent(makeEnvelope({ node: 'node-a', type: 'usage', ts: 42, payload }));

    const body = await (await fetch(`${baseUrl}/api/usage`)).json();
    expect(body).toEqual([{ node: 'node-a', ts: 42, ...payload }]);
  });

  it('serves each node-s found sessions, minus any the hub already hosts', async () => {
    const hosted = randomUUID();
    const outside = randomUUID();
    store.appendEvent(sessionStartedEnvelope(hosted, 'node-a'));
    const { socket } = await connectNode('node-a');
    const found = (id: string) => ({ id, cwd: '/w', title: 't', updatedAt: 1, messages: 1 });
    send(socket, { kind: 'external', sessions: [found(hosted), found(outside)] });

    const start = Date.now();
    let body: unknown = [];
    while (Date.now() - start < 2000) {
      body = await (await fetch(`${baseUrl}/api/external`)).json();
      if ((body as unknown[]).length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(body).toEqual([{ node: 'node-a', sessions: [found(outside)] }]);
  });

  it('forgets a node-s found sessions and projects once it disconnects, so Recruit never offers an offline node', async () => {
    const { socket } = await connectNode('node-a');
    send(socket, {
      kind: 'external',
      sessions: [{ id: randomUUID(), cwd: '/w', title: 't', updatedAt: 1, messages: 1 }],
    });
    send(socket, { kind: 'projects', projects: [{ path: '/w', name: 'w' }] });
    const until = async (check: () => Promise<boolean>) => {
      const start = Date.now();
      while (!(await check()) && Date.now() - start < 2000) await new Promise((r) => setTimeout(r, 10));
    };
    const external = async () => (await (await fetch(`${baseUrl}/api/external`)).json()) as unknown[];
    const projects = async () => (await (await fetch(`${baseUrl}/api/projects`)).json()) as unknown[];
    await until(async () => (await external()).length > 0 && (await projects()).length > 0);
    expect(await external()).toHaveLength(1);

    socket.close();
    await until(async () => (await external()).length === 0);
    expect(await external()).toEqual([]);
    expect(await projects()).toEqual([]);
  });

  it('serves one stream per subscriber even when a client subscribes to the same session twice', async () => {
    const { socket: nodeSocket } = await connectNode('node-a');
    const { socket: clientSocket, frames } = await connectClient();
    const sessionId = randomUUID();
    store.appendEvent(sessionStartedEnvelope(sessionId, 'node-a'));
    send(clientSocket, { kind: 'subscribe', session: sessionId, fromSeq: 0 });
    await frames.waitFor((f) => f.kind === 'synced');
    send(clientSocket, { kind: 'subscribe', session: sessionId, fromSeq: 1 });
    await frames.waitFor(
      (f) => f.kind === 'synced' && f.seq === 0 && frames.frames.filter((x) => x.kind === 'synced').length === 2,
    );

    send(nodeSocket, makeEnvelope({ session: sessionId, node: 'node-a', seq: 1 }));
    await frames.waitFor((f) => f.kind === 'event');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(frames.frames.filter((f) => f.kind === 'event')).toHaveLength(1);
  });

  it('routes session.adopt to the named node, and refuses one the hub already has', async () => {
    const { socket: nodeSocket } = await connectNode('node-a');
    const nodeFrames = new FrameRecorder(nodeSocket);
    const { socket: clientSocket, frames: clientFrames } = await connectClient();

    const fresh = randomUUID();
    send(clientSocket, { kind: 'command', command: { type: 'session.adopt', node: 'node-a', session: fresh } });
    expect(await nodeFrames.waitFor((f) => f.type === 'session.adopt')).toEqual({
      type: 'session.adopt',
      node: 'node-a',
      session: fresh,
    });

    const hosted = randomUUID();
    store.appendEvent(sessionStartedEnvelope(hosted, 'node-a'));
    send(clientSocket, { kind: 'command', command: { type: 'session.adopt', node: 'node-a', session: hosted } });
    expect(await clientFrames.waitFor((f) => f.kind === 'error')).toEqual({
      kind: 'error',
      message: `session already exists: ${hosted}`,
    });
  });

  it('tells every client when a session needs the user, finishes a turn, or fails', async () => {
    const sessionId = randomUUID();
    const { socket: nodeSocket } = await connectNode('node-a');
    const { frames } = await connectClient();
    send(
      nodeSocket,
      sessionStartedEnvelope(sessionId, 'node-a', { payload: { cwd: '/w', prompt: 'Fix it', label: 'Fix it' } }),
    );
    const next = (seq: number, type: Envelope['type'], payload: unknown) =>
      send(nodeSocket, makeEnvelope({ node: 'node-a', session: sessionId, seq, type, payload }));

    next(1, 'permission.request', { requestId: 'r', toolName: 'Bash', input: { command: 'ls' } });
    expect(await frames.waitFor((f) => f.kind === 'attention')).toEqual({
      kind: 'attention',
      node: 'node-a',
      session: sessionId,
      label: 'Fix it',
      reason: 'needs-you',
      detail: 'Bash',
    });
    next(2, 'turn.finished', { outcome: 'success', summary: 'All green.' });
    expect(await frames.waitFor((f) => f.kind === 'attention' && f.reason === 'done')).toMatchObject({
      detail: 'All green.',
    });
    next(3, 'turn.finished', { outcome: 'interrupted' });
    next(4, 'session.ended', { exitCode: 1, signal: null, reason: 'error' });
    expect(await frames.waitFor((f) => f.kind === 'attention' && f.reason === 'failed')).toMatchObject({
      session: sessionId,
    });
    expect(frames.frames.filter((f) => f.kind === 'attention')).toHaveLength(3);
  });

  it('serves the engines each connected node advertised in hello', async () => {
    const socket = await openSocket(`${wsUrl}/node`);
    sockets.push(socket);
    send(socket, { kind: 'hello', node: 'node-a', engines: ['stream', 'interactive'] });
    await connectNode('node-b');
    const start = Date.now();
    let body: { node: string; engines: string[] }[] = [];
    while (body.length < 2 && Date.now() - start < 2000)
      body = (await (await fetch(`${baseUrl}/api/engines`)).json()) as typeof body;
    expect(body).toEqual([
      { node: 'node-a', engines: ['stream', 'interactive'] },
      { node: 'node-b', engines: ['stream'] },
    ]);
  });

  it('GET /api/waiting lists Quests with an unanswered request', async () => {
    const session = randomUUID();
    store.appendEvent(sessionStartedEnvelope(session, 'node-a'));
    store.appendEvent(
      makeEnvelope({
        session,
        seq: 1,
        type: 'permission.request',
        payload: { requestId: 'r', toolName: 'Bash', input: {} },
      }),
    );
    expect(await (await fetch(`${baseUrl}/api/waiting`)).json()).toEqual([{ session, node: 'node-a' }]);
  });

  it('reports the agent CLI version a node sent, until it disconnects', async () => {
    const socket = await openSocket(`${wsUrl}/node`);
    sockets.push(socket);
    send(socket, { kind: 'hello', node: 'node-a' });
    send(socket, { kind: 'cli', version: '2.1.314' });
    const cliOf = async () =>
      ((await (await fetch(`${baseUrl}/api/engines`)).json()) as { node: string; cli?: string }[])[0]?.cli;
    const start = Date.now();
    while ((await cliOf()) !== '2.1.314' && Date.now() - start < 2000) await new Promise((r) => setTimeout(r, 10));
    expect(await cliOf()).toBe('2.1.314');
  });

  it('calls for attention once when a terminal starts asking, not for each change of its screen', async () => {
    const session = randomUUID();
    const { socket } = await connectNode('node-a');
    const client = await openSocket(`${wsUrl}/client`);
    sockets.push(client);
    const frames = new FrameRecorder(client);
    send(
      socket,
      makeEnvelope({
        session,
        seq: 0,
        node: 'node-a',
        type: 'session.started',
        payload: { cwd: '/w', prompt: 'p', label: 'p' },
      }),
    );
    send(
      socket,
      makeEnvelope({
        session,
        seq: 1,
        node: 'node-a',
        type: 'terminal.screen',
        payload: { open: true, raised: true, text: 'a' },
      }),
    );
    send(
      socket,
      makeEnvelope({ session, seq: 2, node: 'node-a', type: 'terminal.screen', payload: { open: true, text: 'b' } }),
    );
    send(
      socket,
      makeEnvelope({ session, seq: 3, node: 'node-a', type: 'turn.finished', payload: { outcome: 'success' } }),
    );
    await frames.waitFor((f) => f.kind === 'attention' && f.reason === 'done');
    const needs = frames.frames.filter((f) => f.kind === 'attention' && f.reason === 'needs-you');
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatchObject({ session, detail: 'Terminal' });
  });

  describe('naming the Kingdom release to run', () => {
    const row = async () =>
      (
        (await (await fetch(`${baseUrl}/api/engines`)).json()) as {
          node: string;
          selfUpdate?: { version: string; state: string; reason?: string };
        }[]
      )[0];

    /** The suite's hub is replaced by one that names this version; its `afterEach` closes it. */
    async function restartWith(kingdomVersion?: string): Promise<void> {
      await app.close();
      app = await buildServer({ store, ...(kingdomVersion ? { kingdomVersion } : {}) });
      await app.listen({ port: 0, host: '127.0.0.1' });
      const { port } = app.server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}`;
      wsUrl = `ws://127.0.0.1:${port}`;
    }

    it('tells a Kingdom that offers self-update, and only that one', async () => {
      await restartWith('1.2.3');
      const offering = await openSocket(`${wsUrl}/node`);
      const other = await openSocket(`${wsUrl}/node`);
      sockets.push(offering, other);
      const offeringFrames = new FrameRecorder(offering);
      const otherFrames = new FrameRecorder(other);
      send(other, { kind: 'hello', node: 'node-b' });
      send(offering, { kind: 'hello', node: 'node-a', selfUpdate: true });
      expect(await offeringFrames.waitFor((f) => f.kind === 'kingdom-version')).toEqual({
        kind: 'kingdom-version',
        version: '1.2.3',
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(otherFrames.frames.filter((f) => f.kind === 'kingdom-version')).toEqual([]);
    });

    it('says so when it names nothing, so a Kingdom partway through an update stops', async () => {
      await restartWith();
      const socket = await openSocket(`${wsUrl}/node`);
      sockets.push(socket);
      const frames = new FrameRecorder(socket);
      send(socket, { kind: 'hello', node: 'node-a', selfUpdate: true });
      expect(await frames.waitFor((f) => f.kind === 'kingdom-version')).toEqual({ kind: 'kingdom-version' });
    });

    it('shows how a Kingdom’s update is going until it reconnects', async () => {
      await restartWith('1.2.3');
      const socket = await openSocket(`${wsUrl}/node`);
      sockets.push(socket);
      send(socket, { kind: 'hello', node: 'node-a', selfUpdate: true });
      send(socket, { kind: 'self-update', version: '1.2.3', state: 'failed', reason: 'no attestation' });
      const start = Date.now();
      while (!(await row())?.selfUpdate && Date.now() - start < 2000) await new Promise((r) => setTimeout(r, 10));
      expect((await row())?.selfUpdate).toEqual({ version: '1.2.3', state: 'failed', reason: 'no attestation' });

      socket.close();
      const again = await openSocket(`${wsUrl}/node`);
      sockets.push(again);
      send(again, { kind: 'hello', node: 'node-a', selfUpdate: true });
      const restarted = Date.now();
      while ((await row())?.selfUpdate && Date.now() - restarted < 2000) await new Promise((r) => setTimeout(r, 10));
      expect((await row())?.selfUpdate).toBeUndefined();
    });
  });

  describe('updating a Kingdom-s agent CLI', () => {
    const update = (node: string) => fetch(`${baseUrl}/api/nodes/${node}/cli-update`, { method: 'POST' });
    const engineRow = async () =>
      (
        (await (await fetch(`${baseUrl}/api/engines`)).json()) as { node: string; cli?: string; cliUpdate?: boolean }[]
      )[0];

    async function updaterNode(nodeId: string): Promise<{ socket: WebSocket; frames: FrameRecorder }> {
      const socket = await openSocket(`${wsUrl}/node`);
      sockets.push(socket);
      const frames = new FrameRecorder(socket);
      send(socket, { kind: 'hello', node: nodeId, cliUpdate: true });
      const start = Date.now();
      while (!(await engineRow())?.cliUpdate && Date.now() - start < 2000) await new Promise((r) => setTimeout(r, 10));
      return { socket, frames };
    }

    it('says which Kingdoms can do it', async () => {
      await updaterNode('node-a');
      expect((await engineRow())?.cliUpdate).toBe(true);
    });

    it('asks the node, and answers with the version the node reports', async () => {
      const { socket, frames } = await updaterNode('node-a');
      const answer = update('node-a');
      const asked = (await frames.waitFor((f) => f.kind === 'cli-update')) as { requestId: string };
      send(socket, { kind: 'cli-updated', requestId: asked.requestId, ok: true, version: '2.1.320' });
      const response = await answer;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ version: '2.1.320' });
      expect((await engineRow())?.cli).toBe('2.1.320');
    });

    it('passes on why the node refused', async () => {
      const { socket, frames } = await updaterNode('node-a');
      const answer = update('node-a');
      const asked = (await frames.waitFor((f) => f.kind === 'cli-update')) as { requestId: string };
      send(socket, { kind: 'cli-updated', requestId: asked.requestId, ok: false, reason: '2 Quests are busy' });
      const response = await answer;
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: '2 Quests are busy' });
    });

    it('refuses a second update while one runs', async () => {
      const { socket, frames } = await updaterNode('node-a');
      const first = update('node-a');
      const asked = (await frames.waitFor((f) => f.kind === 'cli-update')) as { requestId: string };
      expect((await update('node-a')).status).toBe(409);
      send(socket, { kind: 'cli-updated', requestId: asked.requestId, ok: true });
      expect((await first).status).toBe(200);
    });

    it('ignores an answer it did not ask for, or from another node', async () => {
      const { socket, frames } = await updaterNode('node-a');
      const answer = update('node-a');
      const asked = (await frames.waitFor((f) => f.kind === 'cli-update')) as { requestId: string };
      const other = await openSocket(`${wsUrl}/node`);
      sockets.push(other);
      send(other, { kind: 'hello', node: 'node-b', cliUpdate: true });
      send(other, { kind: 'cli-updated', requestId: asked.requestId, ok: true, version: '9.9.9' });
      send(socket, { kind: 'cli-updated', requestId: randomUUID(), ok: true, version: '9.9.9' });
      send(socket, { kind: 'cli-updated', requestId: asked.requestId, ok: true, version: '2.1.320' });
      expect(await (await answer).json()).toEqual({ version: '2.1.320' });
    });

    it('answers when the node drops mid-update', async () => {
      const { socket, frames } = await updaterNode('node-a');
      const answer = update('node-a');
      await frames.waitFor((f) => f.kind === 'cli-update');
      socket.terminate();
      const response = await answer;
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toMatch(/offline/);
    });

    it('refuses an offline Kingdom', async () => {
      expect((await update('nobody')).status).toBe(404);
    });

    it('refuses a Crystal too old to do it, rather than waiting on it', async () => {
      await connectNode('node-a');
      const start = Date.now();
      while (!(await engineRow()) && Date.now() - start < 2000) await new Promise((r) => setTimeout(r, 10));
      expect((await update('node-a')).status).toBe(409);
    });

    it('takes no such command over the client socket', async () => {
      expect(
        ClientMessage.safeParse({ kind: 'command', command: { type: 'cli-update', node: 'node-a' } }).success,
      ).toBe(false);
    });
  });

  it('GET /api/cli-latest is empty when the hub does not check', async () => {
    expect(await (await fetch(`${baseUrl}/api/cli-latest`)).json()).toEqual({});
  });

  it('reports the release a node said in hello alongside its engines', async () => {
    const socket = await openSocket(`${wsUrl}/node`);
    sockets.push(socket);
    send(socket, { kind: 'hello', node: 'node-r', release: '0123456789ab' });
    const start = Date.now();
    let body: { node: string; release?: string }[] = [];
    while (body.length < 1 && Date.now() - start < 2000)
      body = (await (await fetch(`${baseUrl}/api/engines`)).json()) as typeof body;
    expect(body).toEqual([{ node: 'node-r', engines: ['stream'], release: '0123456789ab' }]);
  });

  it('serves turn totals since a time, and the recent activity feed', async () => {
    const session = randomUUID();
    store.appendEvent(sessionStartedEnvelope(session, 'node-a', { ts: 1000 }));
    store.appendEvent(
      makeEnvelope({
        session,
        node: 'node-a',
        seq: 1,
        ts: 5000,
        type: 'turn.finished',
        payload: { outcome: 'success', costUsd: 0.5 },
      }),
    );
    const stats = await (await fetch(`${baseUrl}/api/stats?since=1000`)).json();
    expect(stats).toMatchObject([{ node: 'node-a', turns: 1, kos: 0, costUsd: 0.5 }]);
    expect(await (await fetch(`${baseUrl}/api/stats?since=9999999999999`)).json()).toEqual([]);
    const activity = (await (await fetch(`${baseUrl}/api/activity?limit=1`)).json()) as unknown[];
    expect(activity).toEqual([
      { session, node: 'node-a', label: 'say hello', ts: 5000, kind: 'turn', outcome: 'success' },
    ]);
    expect((await fetch(`${baseUrl}/api/stats?since=soon`)).status).toBe(400);
    const xp = (await (await fetch(`${baseUrl}/api/xp`)).json()) as unknown[];
    expect(xp).toContainEqual({ session, node: 'node-a', won: 1, kos: 0, completed: false });
  });

  it('serves each node-s project folders', async () => {
    const { socket } = await connectNode('node-a');
    const projects = [{ path: '/w/app', name: 'app', lastUsed: 3 }];
    send(socket, { kind: 'projects', projects });
    const start = Date.now();
    let body: unknown = [];
    while ((body as unknown[]).length === 0 && Date.now() - start < 2000)
      body = await (await fetch(`${baseUrl}/api/projects`)).json();
    expect(body).toEqual([{ node: 'node-a', projects }]);
  });

  it('routes session.close to the session-s node with resume filled in, like a follow-up', async () => {
    const { socket: nodeSocket } = await connectNode('node-a');
    const nodeFrames = new FrameRecorder(nodeSocket);
    const { socket: clientSocket } = await connectClient();
    const sessionId = randomUUID();
    store.appendEvent(sessionStartedEnvelope(sessionId, 'node-a'));
    send(clientSocket, {
      kind: 'command',
      command: { type: 'session.close', session: sessionId, removeWorktree: true },
    });
    expect(await nodeFrames.waitFor((f) => f.type === 'session.close')).toEqual({
      type: 'session.close',
      session: sessionId,
      removeWorktree: true,
      resume: { cwd: '/tmp/work', nextSeq: 1 },
    });
  });

  it('names the session-s engine and effort in the resume it fills in, so a restarted node rebuilds it the same', async () => {
    const { socket: nodeSocket } = await connectNode('node-a');
    const nodeFrames = new FrameRecorder(nodeSocket);
    const { socket: clientSocket } = await connectClient();
    const sessionId = randomUUID();
    store.appendEvent(
      sessionStartedEnvelope(sessionId, 'node-a', {
        payload: { cwd: '/tmp/work', prompt: 'p', label: 'p', engine: 'interactive', effort: 'high' },
      }),
    );
    send(clientSocket, { kind: 'command', command: { type: 'session.send', session: sessionId, text: 'hi' } });
    expect(await nodeFrames.waitFor((f) => f.type === 'session.send')).toMatchObject({
      resume: { cwd: '/tmp/work', nextSeq: 1, engine: 'interactive', effort: 'high' },
    });
    send(clientSocket, { kind: 'command', command: { type: 'session.close', session: sessionId } });
    expect(await nodeFrames.waitFor((f) => f.type === 'session.close')).toMatchObject({
      resume: { cwd: '/tmp/work', nextSeq: 1, engine: 'interactive', effort: 'high' },
    });
  });

  it('GET /api/search searches one node, and needs both a node and a query of 2+ characters', async () => {
    const session = randomUUID();
    store.appendEvent(
      sessionStartedEnvelope(session, 'node-a', {
        payload: { cwd: '/w', prompt: 'Fix the parser', label: 'Fix the parser' },
      }),
    );
    const body = await (await fetch(`${baseUrl}/api/search?node=node-a&q=parser`)).json();
    expect(body).toEqual([expect.objectContaining({ session, seq: 0, label: 'Fix the parser' })]);
    expect(await (await fetch(`${baseUrl}/api/search?node=node-b&q=parser`)).json()).toEqual([]);
    expect(await (await fetch(`${baseUrl}/api/search?node=node-a&q=p`)).json()).toEqual([]);
    expect((await fetch(`${baseUrl}/api/search?q=parser`)).status).toBe(400);
  });

  it('GET /api/sessions returns listSessions, newest first', async () => {
    const first = sessionStartedEnvelope(randomUUID(), 'node-a', { ts: 1000 });
    const second = sessionStartedEnvelope(randomUUID(), 'node-a', { ts: 2000 });
    store.appendEvent(first);
    store.appendEvent(second);

    const response = await fetch(`${baseUrl}/api/sessions`);
    const body = (await response.json()) as SessionRow[];
    expect(body).toEqual(store.listSessions());
    expect(body[0]?.id).toBe(second.session);
    expect(body[1]?.id).toBe(first.session);
  });

  it('counts the bytes it relays per session, replay and live, and lists them before they are flushed', async () => {
    const session = randomUUID();
    store.appendEvent(sessionStartedEnvelope(session, 'node-a'));
    const { socket: nodeSocket } = await connectNode('node-a');
    const { socket: clientSocket, frames } = await connectClient();
    let received = 0;
    clientSocket.on('message', (data: Buffer) => {
      received += data.length;
    });
    send(clientSocket, { kind: 'subscribe', session, fromSeq: 0 });
    await frames.waitFor((f) => f.kind === 'synced');
    send(nodeSocket, makeEnvelope({ session, node: 'node-a', seq: 1 }));
    await frames.waitFor((f) => f.kind === 'event');

    const body = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as { id: string; relayedBytes: number }[];
    // Every frame about this session counts; `synced` is the only one the counter and the socket share besides it.
    expect(body.find((s) => s.id === session)?.relayedBytes).toBe(received);
  });

  it('GET /api/nodes returns the connected node ids, and drops a node on disconnect', async () => {
    const { socket: nodeASocket } = await connectNode('node-a');
    await connectNode('node-b');

    // give the hello frames a tick to be handled
    await new Promise((resolve) => setTimeout(resolve, 50));

    const response = await fetch(`${baseUrl}/api/nodes`);
    const body = (await response.json()) as string[];
    expect(new Set(body)).toEqual(new Set(['node-a', 'node-b']));

    nodeASocket.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const afterDisconnect = (await (await fetch(`${baseUrl}/api/nodes`)).json()) as string[];
    expect(afterDisconnect).toEqual(['node-b']);
  });

  it('drops frames sent before hello, and envelopes whose node differs from the hello node', async () => {
    const socket = await openSocket(`${wsUrl}/node`);
    sockets.push(socket);
    const frames = new FrameRecorder(socket);

    // Sent before hello: must be dropped, no ack.
    const tooEarly = makeEnvelope({ node: 'node-a' });
    send(socket, tooEarly);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(frames.frames).toHaveLength(0);

    send(socket, { kind: 'hello', node: 'node-a' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // node field mismatched with hello: must be dropped, no ack.
    const mismatched = makeEnvelope({ node: 'node-b' });
    send(socket, mismatched);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(frames.frames.filter((f) => f.kind === 'ack')).toHaveLength(0);
    expect(store.eventsSince(mismatched.session, 0)).toHaveLength(0);
    expect(store.eventsSince(tooEarly.session, 0)).toHaveLength(0);

    // the connection still works for a well-formed envelope afterward
    const good = makeEnvelope({ node: 'node-a' });
    send(socket, good);
    const ack = await frames.waitFor((f) => f.kind === 'ack');
    expect(ack).toEqual({ kind: 'ack', session: good.session, seq: good.seq });
  });

  it('acks an envelope whose payload fails the store schema, so the node stops resending it, and tells subscribers', async () => {
    const { socket } = await connectNode('node-a');
    const frames = new FrameRecorder(socket);

    const bad = makeEnvelope({ type: 'session.started', payload: { missing: 'fields' } });
    const { socket: clientSocket, frames: clientFrames } = await connectClient();
    send(clientSocket, { kind: 'subscribe', session: bad.session, fromSeq: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    send(socket, bad);
    const ack = await frames.waitFor((f) => f.kind === 'ack' && f.session === bad.session);
    expect(ack).toEqual({ kind: 'ack', session: bad.session, seq: bad.seq });
    const error = await clientFrames.waitFor((f) => f.kind === 'error');
    expect(typeof (error as { message: string }).message).toBe('string');
    expect(clientFrames.frames.filter((f) => f.kind === 'event')).toHaveLength(0);
    expect(store.eventsSince(bad.session, 0)).toHaveLength(0);

    // the connection survives and keeps acking well-formed envelopes
    const good = makeEnvelope();
    send(socket, good);
    const goodAck = await frames.waitFor((f) => f.kind === 'ack' && f.session === good.session);
    expect(goodAck).toEqual({ kind: 'ack', session: good.session, seq: good.seq });
  });

  it('relays a node-error about a session to that session-s subscribers only, without storing it', async () => {
    const sessionId = randomUUID();
    store.appendEvent(sessionStartedEnvelope(sessionId, 'node-a'));

    const { socket: nodeSocket } = await connectNode('node-a');
    const { socket: subSocket, frames: subFrames } = await connectClient();
    const { frames: otherFrames } = await connectClient();
    send(subSocket, { kind: 'subscribe', session: sessionId, fromSeq: 0 });
    await subFrames.waitFor((f) => f.kind === 'synced');

    send(nodeSocket, { kind: 'node-error', session: sessionId, message: `unknown session: ${sessionId}` });

    const error = await subFrames.waitFor((f) => f.kind === 'error');
    expect(error).toEqual({ kind: 'error', message: `unknown session: ${sessionId}` });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(otherFrames.frames).toHaveLength(0);
    expect(store.eventsSince(sessionId, 0)).toHaveLength(1);
  });

  it('relays a node-error with no session to every client', async () => {
    const { socket: nodeSocket } = await connectNode('node-a');
    const { frames: aFrames } = await connectClient();
    const { frames: bFrames } = await connectClient();
    await new Promise((resolve) => setTimeout(resolve, 50));

    send(nodeSocket, { kind: 'node-error', message: 'node trouble' });

    expect(await aFrames.waitFor((f) => f.kind === 'error')).toEqual({ kind: 'error', message: 'node trouble' });
    expect(await bFrames.waitFor((f) => f.kind === 'error')).toEqual({ kind: 'error', message: 'node trouble' });
  });

  it('acks but drops an envelope for a session that belongs to another node', async () => {
    const sessionId = randomUUID();
    store.appendEvent(sessionStartedEnvelope(sessionId, 'node-a'));
    const { socket, frames } = await connectNode('node-b');

    const intruder = makeEnvelope({ node: 'node-b', session: sessionId, seq: 1 });
    send(socket, intruder);

    await frames.waitFor((f) => f.kind === 'ack' && f.seq === 1);
    expect(store.eventsSince(sessionId, 0).map((e) => e.seq)).toEqual([0]);
  });
});

describe('airship server with Web Push', () => {
  let store: Store;
  let app: import('fastify').FastifyInstance;
  let baseUrl: string;
  let wsUrl: string;
  let sockets: WebSocket[];
  let pushed: Attention[];
  let failPush: boolean;

  beforeEach(async () => {
    store = openStore(':memory:');
    pushed = [];
    failPush = false;
    const pusher = {
      async notify(attention: Attention) {
        pushed.push(attention);
        if (failPush) throw new Error('push service down');
      },
    };
    app = await buildServer({ store, push: { publicKey: 'public-key', pusher } });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    wsUrl = `ws://127.0.0.1:${address.port}`;
    sockets = [];
  });

  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    await app.close();
    store.close();
  });

  const subscription = { endpoint: 'https://push.example/a', keys: { p256dh: 'p', auth: 'a' } };
  const json = (method: string, body: unknown) => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('serves the VAPID public key', async () => {
    expect(await (await fetch(`${baseUrl}/api/push/key`)).json()).toEqual({ publicKey: 'public-key' });
  });

  it('stores a device-s subscription and prefs, updates them, and deletes them', async () => {
    const put = (prefs: unknown) => fetch(`${baseUrl}/api/push/subscription`, json('PUT', { subscription, prefs }));
    expect((await put({ names: {}, hidden: [] })).status).toBe(204);
    expect((await put({ names: { n: 'A' }, hidden: [], notify: { n: 'discreet' } })).status).toBe(204);
    expect(store.listPushSubscriptions()).toEqual([
      { subscription, prefs: { names: { n: 'A' }, hidden: [], notify: { n: 'discreet' } } },
    ]);
    expect((await put({ names: {}, hidden: 'all' })).status).toBe(400);

    const del = await fetch(`${baseUrl}/api/push/subscription`, json('DELETE', { endpoint: subscription.endpoint }));
    expect(del.status).toBe(204);
    expect(store.listPushSubscriptions()).toEqual([]);
  });

  it('hands every attention to the pusher, and a failing push never stops the acks', async () => {
    const socket = await openSocket(`${wsUrl}/node`);
    sockets.push(socket);
    const frames = new FrameRecorder(socket);
    send(socket, { kind: 'hello', node: 'node-a' });
    const sessionId = randomUUID();
    failPush = true;
    send(socket, sessionStartedEnvelope(sessionId, 'node-a'));
    send(
      socket,
      makeEnvelope({
        node: 'node-a',
        session: sessionId,
        seq: 1,
        type: 'permission.request',
        payload: { requestId: 'r', toolName: 'Bash', input: {} },
      }),
    );
    send(
      socket,
      makeEnvelope({
        node: 'node-a',
        session: sessionId,
        seq: 2,
        type: 'turn.finished',
        payload: { outcome: 'success' },
      }),
    );
    await frames.waitFor((f) => f.kind === 'ack' && f.seq === 2);
    expect(pushed.map((a) => a.reason)).toEqual(['needs-you', 'done']);
    expect(pushed[0]).toMatchObject({ node: 'node-a', session: sessionId, detail: 'Bash' });
  });
});

describe('airship relay counts', () => {
  it('writes relayed bytes to the store on its timer and on close, not per frame', async () => {
    const store = openStore(':memory:');
    const session = randomUUID();
    store.appendEvent(sessionStartedEnvelope(session, 'node-a'));
    const app = await buildServer({ store, relayFlushMs: 60_000 });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const socket = await openSocket(`ws://127.0.0.1:${port}/client`);
    const frames = new FrameRecorder(socket);
    send(socket, { kind: 'subscribe', session, fromSeq: 0 });
    await frames.waitFor((f) => f.kind === 'synced');

    expect(store.listSessions()[0]?.relayedBytes).toBe(0);
    socket.close();
    await app.close();
    expect(store.listSessions()[0]?.relayedBytes).toBeGreaterThan(0);
  });
});

describe('airship relay counts when the store fails', () => {
  it('keeps running and keeps the counts when a flush throws', async () => {
    const store = openStore(':memory:');
    const session = randomUUID();
    store.appendEvent(sessionStartedEnvelope(session, 'node-a'));
    const realAdd = store.addRelayed.bind(store);
    let failures = 1;
    store.addRelayed = (bytes) => {
      if (failures-- > 0) throw new Error('database is locked');
      realAdd(bytes);
    };
    const app = await buildServer({ store, relayFlushMs: 20 });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const socket = await openSocket(`ws://127.0.0.1:${port}/client`);
    const frames = new FrameRecorder(socket);
    send(socket, { kind: 'subscribe', session, fromSeq: 0 });
    await frames.waitFor((f) => f.kind === 'synced');
    // The first flush throws; the next one must still write what was counted before it.
    const start = Date.now();
    while (store.listSessions()[0]?.relayedBytes === 0 && Date.now() - start < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(store.listSessions()[0]?.relayedBytes).toBeGreaterThan(0);
    socket.close();
    await app.close();
  });
});

describe('airship server without Web Push', () => {
  it('says push is off rather than serving a key', async () => {
    const store = openStore(':memory:');
    const app = await buildServer({ store });
    const response = await app.inject({ method: 'GET', url: '/api/push/key' });
    expect(response.statusCode).toBe(404);
    await app.close();
    store.close();
  });
});

describe('airship server checking the latest agent CLI', () => {
  it('GET /api/cli-latest answers with what the checker found', async () => {
    const store = openStore(':memory:');
    const app = await buildServer({ store, latestCli: async () => '2.1.320' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/cli-latest`;
    expect(await (await fetch(url)).json()).toEqual({ latest: '2.1.320' });
    await app.close();
    store.close();
  });
});

describe('airship server with node tokens', () => {
  let tokens: Map<string, string>;
  const registry: NodeRegistry = {
    verify: (token) => tokens.get(token ?? ''),
    ids: () => [...tokens.values()].sort(),
    revoke(node) {
      const token = [...tokens].find(([, id]) => id === node)?.[0];
      return token !== undefined && tokens.delete(token);
    },
    issue(node) {
      const token = `issued-${node}`;
      tokens.set(token, node);
      return token;
    },
  };
  let store: Store;
  let app: import('fastify').FastifyInstance;
  let wsUrl: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    tokens = new Map([
      ['token-a', 'node-a'],
      ['token-b', 'node-b'],
    ]);
    store = openStore(':memory:');
    app = await buildServer({ store, nodes: registry });
    await app.listen({ port: 0, host: '127.0.0.1' });
    wsUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await app.close();
    store.close();
  });

  function dial(token?: string): Promise<{ socket?: WebSocket; status?: number }> {
    return new Promise((resolve) => {
      const socket = new WebSocket(`${wsUrl}/node`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
      sockets.push(socket);
      socket.once('open', () => resolve({ socket }));
      socket.once('unexpected-response', (_req, res) => resolve({ status: res.statusCode }));
      socket.once('error', () => resolve({}));
    });
  }

  async function connectedNodes(): Promise<string[]> {
    const base = wsUrl.replace('ws:', 'http:');
    return (await (await fetch(`${base}/api/nodes`)).json()) as string[];
  }

  it('refuses a node connection without a valid token', async () => {
    expect((await dial()).status).toBe(401);
    expect((await dial('wrong')).status).toBe(401);
  });

  it('accepts a node whose hello matches its token', async () => {
    const { socket } = await dial('token-a');
    send(socket!, { kind: 'hello', node: 'node-a' });
    const start = Date.now();
    while (!(await connectedNodes()).includes('node-a') && Date.now() - start < 2000)
      await new Promise((r) => setTimeout(r, 10));
    expect(await connectedNodes()).toEqual(['node-a']);
  });

  it('closes a connection whose hello claims a different node than its token', async () => {
    const { socket } = await dial('token-a');
    const closed = new Promise<number>((resolve) => socket!.once('close', (code) => resolve(code)));
    send(socket!, { kind: 'hello', node: 'node-b' });
    expect(await closed).toBe(4003);
    expect(await connectedNodes()).toEqual([]);
  });

  it('DELETE /api/nodes/:node revokes the token, cuts the live connection and refuses it from then on', async () => {
    const { socket } = await dial('token-a');
    send(socket!, { kind: 'hello', node: 'node-a' });
    const start = Date.now();
    while (!(await connectedNodes()).includes('node-a') && Date.now() - start < 2000)
      await new Promise((r) => setTimeout(r, 10));
    const closed = new Promise<number>((resolve) => socket!.once('close', (code) => resolve(code)));

    const response = await fetch(`${wsUrl.replace('ws:', 'http:')}/api/nodes/node-a`, { method: 'DELETE' });

    expect(response.status).toBe(204);
    expect(await closed).toBe(4007);
    expect(await connectedNodes()).toEqual([]);
    expect((await dial('token-a')).status).toBe(401);
    expect((await dial('token-b')).socket).toBeDefined();
  });

  async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${wsUrl.replace('ws:', 'http:')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  it('makes a join code for a new node, which trades once for its own token', async () => {
    const made = await post('/api/join-codes', { node: 'node-c' });
    expect(made.status).toBe(200);
    const { code, expiresAt } = (await made.json()) as { code: string; expiresAt: number };
    expect(expiresAt).toBeGreaterThan(Date.now());

    const joined = await post('/api/join', { code });
    expect(joined.status).toBe(200);
    const { node, token } = (await joined.json()) as { node: string; token: string };
    expect(node).toBe('node-c');
    expect((await dial(token)).socket).toBeDefined();
    expect((await post('/api/join', { code })).status).toBe(401);
  });

  it('refuses a join code for a node that already has a token, so one cannot take over a Kingdom', async () => {
    expect((await post('/api/join-codes', { node: 'node-a' })).status).toBe(409);
  });

  it('refuses a join code for a bad node id, and a join without a code', async () => {
    expect((await post('/api/join-codes', { node: 'bad id/x' })).status).toBe(400);
    expect((await post('/api/join', {})).status).toBe(400);
  });

  it('POST /api/leave revokes the caller-s own token and cuts its connection', async () => {
    const { socket } = await dial('token-a');
    send(socket!, { kind: 'hello', node: 'node-a' });
    const start = Date.now();
    while (!(await connectedNodes()).includes('node-a') && Date.now() - start < 2000)
      await new Promise((r) => setTimeout(r, 10));
    const closed = new Promise<number>((resolve) => socket!.once('close', (code) => resolve(code)));

    const left = await post('/api/leave', {}, { authorization: 'Bearer token-a' });

    expect(left.status).toBe(204);
    expect(await closed).toBe(4007);
    expect((await dial('token-a')).status).toBe(401);
    expect((await dial('token-b')).socket).toBeDefined();
  });

  it('slows down guessing at join codes and node tokens, leaving the rest of the hub alone', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await post('/api/join', { code: 'wrong' })).status);
    expect(statuses[0]).toBe(401);
    expect(statuses.at(-1)).toBe(429);
    expect((await post('/api/join-codes', { node: 'node-c' })).status).toBe(200);
  });

  it('lets a whole fleet reconnect at once after a hub restart', async () => {
    const tries: { status?: number }[] = [];
    for (let i = 0; i < 40; i++) tries.push(await dial('wrong'));
    expect(tries.every(({ status }) => status === 401)).toBe(true);
  });

  it('POST /api/leave refuses a missing or unknown token', async () => {
    expect((await post('/api/leave', {})).status).toBe(401);
    expect((await post('/api/leave', {}, { authorization: 'Bearer nope' })).status).toBe(401);
  });

  it('GET /api/nodes/enrolled lists the nodes holding a token, connected or not', async () => {
    const response = await fetch(`${wsUrl.replace('ws:', 'http:')}/api/nodes/enrolled`);
    expect((await response.json()) as string[]).toEqual(expect.arrayContaining(['node-a', 'node-b']));
  });

  it('DELETE /api/nodes/:node/quests refuses a Kingdom that still has a token, and forgets a removed one', async () => {
    const base = wsUrl.replace('ws:', 'http:');
    const session = randomUUID();
    store.appendEvent({
      node: 'node-a',
      session,
      seq: 0,
      ts: Date.now(),
      type: 'session.started',
      payload: { cwd: '/tmp', prompt: 'p', label: 'p' },
    });

    const refused = await fetch(`${base}/api/nodes/node-a/quests`, { method: 'DELETE' });
    expect(refused.status).toBe(409);
    expect(store.getSession(session)).toBeDefined();

    await fetch(`${base}/api/nodes/node-a`, { method: 'DELETE' });
    const forgotten = await fetch(`${base}/api/nodes/node-a/quests`, { method: 'DELETE' });
    expect(forgotten.status).toBe(204);
    expect(store.getSession(session)).toBeUndefined();
    expect(((await (await fetch(`${base}/api/nodes/enrolled`)).json()) as string[]).includes('node-a')).toBe(false);
  });

  it('DELETE /api/nodes/:node answers 404 for a node with no token', async () => {
    const response = await fetch(`${wsUrl.replace('ws:', 'http:')}/api/nodes/node-z`, { method: 'DELETE' });
    expect(response.status).toBe(404);
  });
});

describe('airship server hub name', () => {
  let store: Store;
  let app: import('fastify').FastifyInstance;
  let base: string;
  let name: string | undefined;

  beforeEach(async () => {
    store = openStore(':memory:');
    name = undefined;
    const settings = {
      name: () => name,
      setName(next: string | undefined) {
        name = next;
      },
    };
    app = await buildServer({ store, settings });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await app.close();
    store.close();
  });

  const put = (body: unknown) =>
    fetch(`${base}/api/hub`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('starts unnamed, takes a name, and an empty one clears it', async () => {
    expect(await (await fetch(`${base}/api/hub`)).json()).toEqual({ name: null });
    expect((await put({ name: '  Home fleet ' })).status).toBe(204);
    expect(await (await fetch(`${base}/api/hub`)).json()).toEqual({ name: 'Home fleet' });
    expect((await put({ name: '' })).status).toBe(204);
    expect(name).toBeUndefined();
  });

  it('refuses a name it cannot show', async () => {
    expect((await put({ name: 'x'.repeat(41) })).status).toBe(400);
    expect((await put({ name: 7 })).status).toBe(400);
    expect(name).toBeUndefined();
  });
});

describe('airship server on first run', () => {
  let store: Store;
  let app: import('fastify').FastifyInstance;
  let base: string;
  let firstRun: FirstRun;
  let logins: Map<string, string>;

  beforeEach(async () => {
    store = openStore(':memory:');
    logins = new Map();
    const tokens: NodeRegistry = {
      verify: (token) => logins.get(token ?? ''),
      ids: () => [...logins.values()],
      revoke: () => false,
      issue(name) {
        logins.set(`token-of-${name}`, name);
        return `token-of-${name}`;
      },
    };
    firstRun = createFirstRun(tokens);
    app = await buildServer({ store, auth: accessTokens(tokens), firstRun });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await app.close();
    store.close();
  });

  const setup = (body: unknown) =>
    fetch(`${base}/api/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const me = async () => (await (await fetch(`${base}/api/me`)).json()) as Record<string, unknown>;

  it('says setup is pending, and stays locked meanwhile', async () => {
    expect(await me()).toEqual({ login: null, canLogIn: true, setup: true });
    expect((await fetch(`${base}/api/sessions`)).status).toBe(403);
    expect((await fetch(`${base}/api/join-codes`, { method: 'POST' })).status).toBe(403);
    expect((await fetch(`${base}/api/hub`)).status).toBe(403);
  });

  it('refuses a wrong code, a missing code and a bad name', async () => {
    expect((await setup({ code: 'nope', name: 'me' })).status).toBe(401);
    expect((await setup({ name: 'me' })).status).toBe(401);
    expect((await setup({ code: firstRun.code, name: 'not a name!' })).status).toBe(400);
    expect(logins.size).toBe(0);
    expect((await me()).setup).toBe(true);
  });

  it('trades the code for the first login once, logging that browser in', async () => {
    const response = await setup({ code: firstRun.code, name: 'me' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ login: 'me', token: 'token-of-me' });
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    expect((await fetch(`${base}/api/sessions`, { headers: { cookie } })).status).toBe(200);

    expect((await setup({ code: firstRun.code, name: 'them' })).status).toBe(409);
    expect((await me()).setup).toBe(false);
  });

  it('never tells anyone the code', async () => {
    expect(JSON.stringify(await me())).not.toContain(firstRun.code);
  });
});

describe('airship server with token login', () => {
  let store: Store;
  let app: import('fastify').FastifyInstance;
  let base: string;
  const sockets: WebSocket[] = [];
  const auth = accessTokens({ verify: (token) => (token === 'good' ? 'laptop' : undefined) });

  beforeEach(async () => {
    store = openStore(':memory:');
    app = await buildServer({ store, auth });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await app.close();
    store.close();
  });

  const login = (token: string) =>
    fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });

  it('has no setup to offer: the route is gone and /api/me says so', async () => {
    const me = (await (await fetch(`${base}/api/me`)).json()) as { setup: boolean };
    expect(me.setup).toBe(false);
    const response = await fetch(`${base}/api/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'x', name: 'me' }),
    });
    expect(response.status).toBe(409);
  });

  it('keeps the API from anyone not logged in, spoofed header or not', async () => {
    expect((await fetch(`${base}/api/sessions`)).status).toBe(403);
    const spoofed = await fetch(`${base}/api/sessions`, { headers: { 'tailscale-user-login': 'me@example.com' } });
    expect(spoofed.status).toBe(403);
  });

  it('keeps the live client socket from anyone not logged in', async () => {
    const socket = new WebSocket(`${base.replace('http:', 'ws:')}/client`);
    sockets.push(socket);
    socket.on('error', () => undefined); // the refused connection closing
    const status = await new Promise<number>((resolve) =>
      socket.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0)),
    );
    expect(status).toBe(403);
  });

  it('trades a good token for a session cookie that opens the API', async () => {
    const response = await login('good');
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    const session = cookie.split(';')[0]!;
    expect((await fetch(`${base}/api/sessions`, { headers: { cookie: session } })).status).toBe(200);
    expect(await (await fetch(`${base}/api/me`, { headers: { cookie: session } })).json()).toEqual({
      login: 'laptop',
      canLogIn: true,
      setup: false,
    });
  });

  it('refuses a bad token and sets no cookie', async () => {
    const response = await login('bad');
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('slows down guessing at the login, and leaves everyone already in alone', async () => {
    const session = (await login('good')).headers.get('set-cookie')!.split(';')[0]!;
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await login('bad')).status);
    expect(statuses[0]).toBe(401);
    expect(statuses.at(-1)).toBe(429);
    expect((await fetch(`${base}/api/sessions`, { headers: { cookie: session } })).status).toBe(200);
  });

  it('says who is asking, so the app knows to show its login page', async () => {
    expect(await (await fetch(`${base}/api/me`)).json()).toEqual({ login: null, canLogIn: true, setup: false });
  });

  it('clears the cookie on logging out', async () => {
    const response = await fetch(`${base}/api/logout`, { method: 'POST' });
    expect(response.status).toBe(204);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('marks the cookie Secure when the hub is reached over HTTPS', async () => {
    const response = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ token: 'good' }),
    });
    expect(response.headers.get('set-cookie')).toContain('Secure');
  });

  it('keeps each login-s appearance apart', async () => {
    const session = (await login('good')).headers.get('set-cookie')!.split(';')[0]!;
    const put = await fetch(`${base}/api/appearance`, {
      method: 'PUT',
      headers: { cookie: session, 'content-type': 'application/json' },
      body: JSON.stringify({ tabStyle: 'tinted' }),
    });
    expect(put.status).toBe(204);
    expect(store.getAppearance('laptop')).toEqual({ tabStyle: 'tinted' });
  });
});

describe('airship server without a login method to use', () => {
  it('answers /api/me for pnpm dev, and has no login route', async () => {
    const store = openStore(':memory:');
    const app = await buildServer({ store });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    expect(await (await fetch(`${base}/api/me`)).json()).toEqual({ login: 'default', canLogIn: false, setup: false });
    const response = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'x' }),
    });
    expect(response.status).toBe(404);
    await app.close();
    store.close();
  });
});

describe('joining a hub with allowed users', () => {
  it('lets a machine with no login trade a code, but only an allowed user make one', async () => {
    const tokens = new Map<string, string>();
    const store = openStore(':memory:');
    const app = await buildServer({
      store,
      auth: tailscaleServe(['me@example.com']),
      nodes: {
        verify: (token) => tokens.get(token ?? ''),
        ids: () => [...tokens.values()],
        revoke: () => false,
        issue(node) {
          tokens.set('token', node);
          return 'token';
        },
      },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const post = (path: string, body: unknown, login?: string) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(login ? { 'tailscale-user-login': login } : {}) },
        body: JSON.stringify(body),
      });

    expect((await post('/api/join-codes', { node: 'node-a' })).status).toBe(403);
    const made = await post('/api/join-codes', { node: 'node-a' }, 'me@example.com');
    const { code } = (await made.json()) as { code: string };
    expect((await post('/api/join', { code })).status).toBe(200);
    await app.close();
    store.close();
  });
});

describe('airship server with allowed users', () => {
  let store: Store;
  let app: import('fastify').FastifyInstance;
  let baseUrl: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    store = openStore(':memory:');
    app = await buildServer({ store, auth: tailscaleServe(['me@example.com']) });
    await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await app.close();
    store.close();
  });

  const as = (login?: string) => (login ? { headers: { 'tailscale-user-login': login } } : {});

  it('serves the API only to an allowed tailnet user', async () => {
    expect((await fetch(`${baseUrl}/api/sessions`, as('me@example.com'))).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/sessions`, as('someone@example.com'))).status).toBe(403);
    expect((await fetch(`${baseUrl}/api/sessions`)).status).toBe(403);
  });

  it('matches the login without regard to case', async () => {
    expect((await fetch(`${baseUrl}/api/nodes`, as('Me@Example.com'))).status).toBe(200);
  });

  it('keeps the health check open', async () => {
    expect((await fetch(`${baseUrl}/api/health`)).status).toBe(200);
  });

  it('refuses a client WebSocket without an allowed user, and accepts one with', async () => {
    const dial = (login?: string) =>
      new Promise<number | 'open'>((resolve) => {
        const socket = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/client`, as(login));
        sockets.push(socket);
        socket.once('open', () => resolve('open'));
        socket.once('unexpected-response', (req, res) => {
          resolve(res.statusCode ?? 0);
          req.destroy(); // drop the refused upgrade so the server can close cleanly
        });
        socket.once('error', () => {});
      });
    expect(await dial()).toBe(403);
    expect(await dial('me@example.com')).toBe('open');
  });

  it('closes a refused upgrade, so it does not hold the server open', async () => {
    const socket = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/client`);
    socket.once('error', () => {});
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    await closed;
    const start = Date.now();
    await app.close();
    expect(Date.now() - start).toBeLessThan(1000);
    app = await buildServer({ store, auth: tailscaleServe(['me@example.com']) }); // for afterEach
  });

  it('leaves /node to node tokens: no tailnet user is required there', async () => {
    const socket = await openSocket(`${baseUrl.replace('http:', 'ws:')}/node`);
    sockets.push(socket);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });
});

describe('airship server appearance', () => {
  let store: Store;
  let app: import('fastify').FastifyInstance;
  let baseUrl: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    store = openStore(':memory:');
    app = await buildServer({ store, auth: tailscaleServe(['me@example.com', 'you@example.com']) });
    await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await app.close();
    store.close();
  });

  const as = (login: string, body?: unknown) => ({
    method: body === undefined ? 'GET' : 'PUT',
    headers: { 'tailscale-user-login': login, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function client(login: string) {
    const socket = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/client`, {
      headers: { 'tailscale-user-login': login },
    });
    sockets.push(socket);
    await new Promise((resolve) => socket.once('open', resolve));
    return new FrameRecorder(socket);
  }

  it('keeps each user-s appearance, shared by all their devices, and refuses bad ones', async () => {
    expect(await (await fetch(`${baseUrl}/api/appearance`, as('me@example.com'))).json()).toEqual({});
    const mine = { tabStyle: 'tinted', looks: { n: { icon: 'castle', colour: '#3550c8' } } };
    expect((await fetch(`${baseUrl}/api/appearance`, as('Me@Example.com', mine))).status).toBe(204);
    expect(await (await fetch(`${baseUrl}/api/appearance`, as('me@example.com'))).json()).toEqual(mine);
    expect(await (await fetch(`${baseUrl}/api/appearance`, as('you@example.com'))).json()).toEqual({});
    const bad = await fetch(`${baseUrl}/api/appearance`, as('me@example.com', { looks: { n: { colour: 'red' } } }));
    expect(bad.status).toBe(400);
  });

  it('tells that user-s other open tabs at once, and nobody else', async () => {
    const mineOpen = await client('me@example.com');
    const theirs = await client('you@example.com');
    await fetch(`${baseUrl}/api/appearance`, as('me@example.com', { tabStyle: 'pennant' }));
    expect(await mineOpen.waitFor((f) => f.kind === 'appearance')).toEqual({
      kind: 'appearance',
      appearance: { tabStyle: 'pennant' },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(theirs.frames.some((f) => f.kind === 'appearance')).toBe(false);
  });
});

describe('airship server appearance without tailnet logins', () => {
  it('keeps one shared appearance, as in pnpm dev', async () => {
    const store = openStore(':memory:');
    const app = await buildServer({ store });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    await fetch(`${base}/api/appearance`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tabStyle: 'tinted' }),
    });
    expect(await (await fetch(`${base}/api/appearance`)).json()).toEqual({ tabStyle: 'tinted' });
    await app.close();
    store.close();
  });
});
