import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionDecision, PermissionRequest } from './permissions.js';
import { startNode, type CrystalNode, type SessionFactory, type SessionLike } from './node.js';

// Captured before any test fakes the global timers, so test-side waits for real socket I/O
// keep working even while a test is driving reconnection with `vi.useFakeTimers()`.
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realClearTimeout = globalThis.clearTimeout.bind(globalThis);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, ms));
}

class FakeSession extends EventEmitter implements SessionLike {
  start = vi.fn((_prompt: string) => {});
  send = vi.fn((_text: string) => {});
  interrupt = vi.fn(() => {});
  close = vi.fn(() => {});
  stopped = vi.fn(() => this.stoppedPromise);
  stoppedPromise: Promise<void> = Promise.resolve();
  busy = false;
  busyReason: string | undefined = undefined;
  setMode = vi.fn((_mode: string) => {});
}

interface ConnRecorder {
  socket: import('ws').WebSocket;
  frames: Record<string, unknown>[];
  emitter: EventEmitter;
  authorization: string | undefined;
}

interface ServerHarness {
  httpServer: HttpServer;
  wss: WebSocketServer;
  url: string;
  connections: ConnRecorder[];
  connectionEmitter: EventEmitter;
  rejectNextConnections: number;
}

function startHarness(): Promise<ServerHarness> {
  return new Promise((resolve) => {
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer, path: '/node' });
    const connections: ConnRecorder[] = [];
    const connectionEmitter = new EventEmitter();
    const harness: ServerHarness = {
      httpServer,
      wss,
      url: '',
      connections,
      connectionEmitter,
      rejectNextConnections: 0,
    };

    // Raw TCP connections, before any WebSocket handshake: used to simulate a node whose
    // reconnect attempt fails outright (destroyed before `open` could ever fire).
    httpServer.on('connection', (socket) => {
      if (harness.rejectNextConnections > 0) {
        harness.rejectNextConnections--;
        socket.destroy();
      }
    });

    wss.on('connection', (socket, req) => {
      const frames: Record<string, unknown>[] = [];
      const emitter = new EventEmitter();
      socket.on('message', (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        frames.push(frame);
        emitter.emit('frame', frame);
      });
      const recorder: ConnRecorder = { socket, frames, emitter, authorization: req.headers.authorization };
      connections.push(recorder);
      connectionEmitter.emit('connection');
    });

    httpServer.listen(0, '127.0.0.1', () => {
      const address = httpServer.address() as AddressInfo;
      harness.url = `ws://127.0.0.1:${address.port}/node`;
      resolve(harness);
    });
  });
}

function nextConnection(harness: ServerHarness, afterIndex: number): Promise<ConnRecorder> {
  const existing = harness.connections[afterIndex];
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    harness.connectionEmitter.once('connection', () => {
      resolve(harness.connections[afterIndex]!);
    });
  });
}

/** Waits for a frame matching `predicate`, starting the search at `fromIndex` in `conn.frames`. */
function waitForNewFrame(
  conn: ConnRecorder,
  fromIndex: number,
  predicate: (frame: Record<string, unknown>) => boolean,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  for (let i = fromIndex; i < conn.frames.length; i++) {
    const frame = conn.frames[i]!;
    if (predicate(frame)) return Promise.resolve(frame);
  }
  return new Promise((resolve, reject) => {
    const timer = realSetTimeout(() => {
      conn.emitter.off('frame', handler);
      reject(new Error('timed out waiting for frame'));
    }, timeoutMs);
    function handler(frame: Record<string, unknown>): void {
      if (predicate(frame)) {
        realClearTimeout(timer);
        conn.emitter.off('frame', handler);
        resolve(frame);
      }
    }
    conn.emitter.on('frame', handler);
  });
}

function waitForFrame(
  conn: ConnRecorder,
  predicate: (frame: Record<string, unknown>) => boolean,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  return waitForNewFrame(conn, 0, predicate, timeoutMs);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await delay(10);
  }
}

async function closeHarness(harness: ServerHarness): Promise<void> {
  for (const conn of harness.connections) conn.socket.terminate();
  await new Promise<void>((resolve) => harness.wss.close(() => resolve()));
  await new Promise<void>((resolve) => harness.httpServer.close(() => resolve()));
}

const PERMISSION_URL_BASE = 'http://127.0.0.1:9999';

describe('startNode', () => {
  let harness: ServerHarness;
  let sessionFactory: SessionFactory;
  let created: Array<{
    opts: {
      session: string;
      cwd: string;
      permissionUrl: string;
      permissionMode?: string;
      forkFrom?: string;
      engine?: string;
    };
    fake: FakeSession;
  }>;
  let permissionServer: { url(session: string): string };
  let node: CrystalNode | undefined;

  beforeEach(async () => {
    harness = await startHarness();
    created = [];
    sessionFactory = vi.fn((opts) => {
      const fake = new FakeSession();
      created.push({ opts, fake });
      return fake;
    });
    permissionServer = { url: (session: string) => `${PERMISSION_URL_BASE}/mcp/${session}` };
  });

  afterEach(async () => {
    node?.close();
    node = undefined;
    await closeHarness(harness);
  });

  function createNode(extra: Partial<Parameters<typeof startNode>[0]> = {}): CrystalNode {
    node = startNode({ hubUrl: harness.url, node: 'test', sessionFactory, permissionServer, ...extra });
    return node;
  }

  it('closes its sessions on close and waits for their processes to stop', async () => {
    createNode();
    const conn = await nextConnection(harness, 0);
    await waitForFrame(conn, (f) => f.kind === 'hello');
    conn.socket.send(
      JSON.stringify({ type: 'session.start', node: 'test', session: randomUUID(), cwd: '/w', prompt: 'p' }),
    );
    await waitUntil(() => created.length === 1);
    let release!: () => void;
    created[0]!.fake.stoppedPromise = new Promise<void>((resolve) => (release = resolve));
    let closed = false;
    const closing = node!.close().then(() => (closed = true));
    expect(created[0]!.fake.close).toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);
    release();
    await closing;
    expect(closed).toBe(true);
    node = undefined;
  });

  it('sends its token as a bearer header when it has one, and none otherwise', async () => {
    node = startNode({ hubUrl: harness.url, node: 'test', token: 's3cret', sessionFactory, permissionServer });
    expect((await nextConnection(harness, 0)).authorization).toBe('Bearer s3cret');
    node.close();

    createNode();
    expect((await nextConnection(harness, 1)).authorization).toBeUndefined();
  });

  it('reports which sessions are mid-turn, for a deploy waiting to restart', async () => {
    const node = createNode();
    const conn = await nextConnection(harness, 0);
    await waitForFrame(conn, (f) => f.kind === 'hello');
    const [a, b] = [randomUUID(), randomUUID()];
    for (const session of [a, b]) {
      conn.socket.send(JSON.stringify({ type: 'session.start', node: 'test', session, cwd: '/w', prompt: 'p' }));
    }
    await waitUntil(() => created.length === 2);

    created[1]!.fake.busy = true;
    created[1]!.fake.busyReason = 'turn open for 4m';
    expect(node.status()).toEqual({ node: 'test', sessions: 2, busy: [b], reasons: { [b]: 'turn open for 4m' } });
  });

  describe('sessions found outside the bridge', () => {
    const found = { id: randomUUID(), cwd: '/home/me/code', title: 'Fix the login test', updatedAt: 5, messages: 3 };
    const replay = [
      { type: 'user.message' as const, payload: { text: 'Fix the login test' } },
      {
        type: 'claude.event' as const,
        payload: { engine: 'claude' as const, raw: { type: 'assistant', message: { id: 'm' } } },
      },
    ];
    const transcripts = {
      list: vi.fn(async () => [found]),
      load: vi.fn(async (id: string) => (id === found.id ? { summary: found, events: replay } : undefined)),
    };

    it('reports them after hello', async () => {
      createNode({ transcripts });
      const conn = await nextConnection(harness, 0);
      const frame = await waitForFrame(conn, (f) => f.kind === 'external');
      expect(frame).toEqual({ kind: 'external', sessions: [found] });
      expect(conn.frames[0]?.kind).toBe('hello');
    });

    it('adopts one: session.started marked adopted, then its history, with no process started', async () => {
      createNode({ transcripts });
      const conn = await nextConnection(harness, 0);
      await waitForFrame(conn, (f) => f.kind === 'external');

      conn.socket.send(JSON.stringify({ type: 'session.adopt', node: 'test', session: found.id }));
      const started = await waitForFrame(conn, (f) => f.type === 'session.started');
      expect(started).toMatchObject({
        session: found.id,
        seq: 0,
        payload: { cwd: '/home/me/code', prompt: 'Fix the login test', label: 'Fix the login test', adopted: true },
      });
      const history = await waitForFrame(conn, (f) => f.type === 'claude.event');
      expect(history).toMatchObject({ seq: 2, payload: replay[1]!.payload });
      expect(conn.frames.find((f) => f.type === 'user.message')).toMatchObject({
        seq: 1,
        payload: { text: 'Fix the login test' },
      });
      expect(created[0]!.opts.cwd).toBe('/home/me/code');
      expect(created[0]!.fake.start).not.toHaveBeenCalled();
    });

    it('adopts on the requested engine, says so in session.started, and refuses one it does not run', async () => {
      createNode({ transcripts, engines: ['stream', 'interactive'] });
      const conn = await nextConnection(harness, 0);
      await waitForFrame(conn, (f) => f.kind === 'external');
      conn.socket.send(
        JSON.stringify({ type: 'session.adopt', node: 'test', session: found.id, engine: 'interactive' }),
      );
      expect(await waitForFrame(conn, (f) => f.type === 'session.started')).toMatchObject({
        payload: { adopted: true, engine: 'interactive' },
      });
      expect(created[0]!.opts).toMatchObject({ engine: 'interactive' });

      node?.close();
      createNode({ transcripts });
      const plain = await nextConnection(harness, 1);
      await waitForFrame(plain, (f) => f.kind === 'external');
      plain.socket.send(
        JSON.stringify({ type: 'session.adopt', node: 'test', session: found.id, engine: 'interactive' }),
      );
      expect(await waitForFrame(plain, (f) => f.kind === 'node-error')).toMatchObject({ session: found.id });
      expect(created).toHaveLength(1);
    });

    it('refuses to adopt a session it already has, or one with no transcript', async () => {
      createNode({ transcripts });
      const conn = await nextConnection(harness, 0);
      await waitForFrame(conn, (f) => f.kind === 'hello');
      const missing = randomUUID();
      conn.socket.send(JSON.stringify({ type: 'session.adopt', node: 'test', session: missing }));
      expect(await waitForFrame(conn, (f) => f.kind === 'node-error')).toMatchObject({ session: missing });
    });
  });

  it('reads a file in a held Quest-s folder for the viewer, answering the request by id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crystal-node-files-'));
    writeFileSync(join(dir, 'notes.md'), '# Notes\n');
    try {
      createNode();
      const conn = await nextConnection(harness, 0);
      await waitForFrame(conn, (f) => f.kind === 'hello');
      const session = randomUUID();
      conn.socket.send(JSON.stringify({ type: 'session.start', node: 'test', session, cwd: dir, prompt: 'p' }));
      await waitForFrame(conn, (f) => f.type === 'session.started');

      const requestId = randomUUID();
      // A cwd from the hub is ignored for a Quest the node holds: it reads from the Quest's own folder.
      conn.socket.send(JSON.stringify({ type: 'file.read', session, requestId, path: 'notes.md', cwd: '/elsewhere' }));
      expect(await waitForFrame(conn, (f) => f.kind === 'file')).toEqual({
        kind: 'file',
        requestId,
        ok: true,
        path: 'notes.md',
        content: '# Notes\n',
        size: 8,
        truncated: false,
      });

      const escape = randomUUID();
      conn.socket.send(JSON.stringify({ type: 'file.read', session, requestId: escape, path: '../../etc/hosts' }));
      expect(await waitForFrame(conn, (f) => f.kind === 'file' && f.requestId === escape)).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/outside/),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads from the hub-filled folder for a Quest it no longer holds, and refuses without one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crystal-node-files-'));
    writeFileSync(join(dir, 'a.txt'), 'hi');
    try {
      createNode();
      const conn = await nextConnection(harness, 0);
      await waitForFrame(conn, (f) => f.kind === 'hello');
      const session = randomUUID();
      const [withCwd, without] = [randomUUID(), randomUUID()];
      conn.socket.send(JSON.stringify({ type: 'file.read', session, requestId: withCwd, path: 'a.txt', cwd: dir }));
      expect(await waitForFrame(conn, (f) => f.kind === 'file' && f.requestId === withCwd)).toMatchObject({
        ok: true,
        content: 'hi',
      });
      conn.socket.send(JSON.stringify({ type: 'file.read', session, requestId: without, path: 'a.txt' }));
      expect(await waitForFrame(conn, (f) => f.kind === 'file' && f.requestId === without)).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/unknown/),
      });
      expect(created).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts a fork in the source folder and says what it forked from', async () => {
    createNode();
    const conn = await nextConnection(harness, 0);
    await waitForFrame(conn, (f) => f.kind === 'hello');
    const [source, fork] = [randomUUID(), randomUUID()];
    conn.socket.send(
      JSON.stringify({ type: 'session.start', node: 'test', session: fork, cwd: '/w', prompt: 'p', forkFrom: source }),
    );
    expect(await waitForFrame(conn, (f) => f.type === 'session.started')).toMatchObject({
      session: fork,
      payload: { cwd: '/w', forkedFrom: source },
    });
    expect(created[0]!.opts).toMatchObject({ session: fork, cwd: '/w', forkFrom: source });
  });

  it('refuses a fork into a new worktree: the conversation is keyed by its folder', async () => {
    createNode({ worktrees: vi.fn() });
    const conn = await nextConnection(harness, 0);
    await waitForFrame(conn, (f) => f.kind === 'hello');
    const fork = randomUUID();
    conn.socket.send(
      JSON.stringify({
        type: 'session.start',
        node: 'test',
        session: fork,
        cwd: '/w',
        prompt: 'p',
        forkFrom: randomUUID(),
        worktree: true,
      }),
    );
    expect(await waitForFrame(conn, (f) => f.kind === 'node-error')).toMatchObject({ session: fork });
    expect(created).toHaveLength(0);
  });

  it('lists its engines in hello, starts a session on the requested one, and refuses one it does not run', async () => {
    createNode({ engines: ['stream', 'interactive'] });
    const conn = await nextConnection(harness, 0);
    expect(await waitForFrame(conn, (f) => f.kind === 'hello')).toMatchObject({ engines: ['stream', 'interactive'] });
    const session = randomUUID();
    conn.socket.send(
      JSON.stringify({ type: 'session.start', node: 'test', session, cwd: '/w', prompt: 'p', engine: 'interactive' }),
    );
    expect(await waitForFrame(conn, (f) => f.type === 'session.started')).toMatchObject({
      payload: { engine: 'interactive' },
    });
    expect(created[0]!.opts).toMatchObject({ engine: 'interactive' });

    node?.close();
    createNode();
    const plain = await nextConnection(harness, 1);
    expect((await waitForFrame(plain, (f) => f.kind === 'hello')).engines).toBeUndefined();
    const refused = randomUUID();
    plain.socket.send(
      JSON.stringify({
        type: 'session.start',
        node: 'test',
        session: refused,
        cwd: '/w',
        prompt: 'p',
        engine: 'interactive',
      }),
    );
    expect(await waitForFrame(plain, (f) => f.kind === 'node-error')).toMatchObject({ session: refused });
    expect(created).toHaveLength(1);
  });

  it('starts a session in the requested mode, falls back to its default, and switches on session.mode', async () => {
    createNode({ defaultMode: 'auto' });
    const conn = await nextConnection(harness, 0);
    await waitForFrame(conn, (f) => f.kind === 'hello');
    const [planned, plain] = [randomUUID(), randomUUID()];
    conn.socket.send(
      JSON.stringify({ type: 'session.start', node: 'test', session: planned, cwd: '/w', prompt: 'p', mode: 'plan' }),
    );
    conn.socket.send(JSON.stringify({ type: 'session.start', node: 'test', session: plain, cwd: '/w', prompt: 'p' }));
    await waitUntil(() => created.length === 2);
    expect(created.map((c) => c.opts.permissionMode)).toEqual(['plan', 'auto']);

    conn.socket.send(JSON.stringify({ type: 'session.mode', session: plain, mode: 'acceptEdits' }));
    await waitUntil(() => created[1]!.fake.setMode.mock.calls.length > 0);
    expect(created[1]!.fake.setMode).toHaveBeenCalledWith('acceptEdits');
  });

  it('answers a question by approving with the answers added to its input', async () => {
    createNode();
    const conn = await nextConnection(harness, 0);
    await waitForFrame(conn, (f) => f.kind === 'hello');
    const sessionId = randomUUID();
    conn.socket.send(
      JSON.stringify({ type: 'session.start', node: 'test', session: sessionId, cwd: '/w', prompt: 'p' }),
    );
    await waitForFrame(conn, (f) => f.type === 'session.started');

    const questions = [{ question: 'Which color?', options: [{ label: 'Red' }, { label: 'Blue' }] }];
    const requestId = randomUUID();
    const decision = node!.handlePermissionRequest({
      session: sessionId,
      requestId,
      toolName: 'AskUserQuestion',
      input: { questions },
    });
    await waitForFrame(conn, (f) => f.type === 'permission.request');
    conn.socket.send(
      JSON.stringify({
        type: 'permission.answer',
        session: sessionId,
        requestId,
        behavior: 'allow',
        answers: { 'Which color?': 'Blue' },
      }),
    );

    expect(await decision).toEqual({
      behavior: 'allow',
      updatedInput: { questions, answers: { 'Which color?': 'Blue' } },
    });
  });

  it('reports its project folders after hello', async () => {
    const projects = [{ path: '/home/me/code/app', name: 'app', lastUsed: 7 }];
    createNode({ projects: async () => projects });
    const conn = await nextConnection(harness, 0);
    expect(await waitForFrame(conn, (f) => f.kind === 'projects')).toEqual({ kind: 'projects', projects });
  });

  it('runs a session in a new worktree when asked, and says where in session.started', async () => {
    const worktrees = vi.fn(async (cwd: string, id: string) => ({
      path: `${cwd}/.worktrees/${id.slice(0, 8)}`,
      root: cwd,
      branch: `cb/${id.slice(0, 8)}`,
    }));
    createNode({ worktrees });
    const conn = await nextConnection(harness, 0);
    await waitForFrame(conn, (f) => f.kind === 'hello');
    const sessionId = randomUUID();
    conn.socket.send(
      JSON.stringify({
        type: 'session.start',
        node: 'test',
        session: sessionId,
        cwd: '/repo',
        prompt: 'p',
        worktree: true,
      }),
    );

    const started = await waitForFrame(conn, (f) => f.type === 'session.started');
    const path = `/repo/.worktrees/${sessionId.slice(0, 8)}`;
    expect(started).toMatchObject({
      payload: { cwd: path, worktree: { root: '/repo', branch: `cb/${sessionId.slice(0, 8)}` } },
    });
    expect(created[0]!.opts.cwd).toBe(path);
  });

  it('answers with a node-error, and starts nothing, when the worktree cannot be made', async () => {
    createNode({
      worktrees: async () => {
        throw new Error('/plain is not a git repository');
      },
    });
    const conn = await nextConnection(harness, 0);
    await waitForFrame(conn, (f) => f.kind === 'hello');
    const sessionId = randomUUID();
    conn.socket.send(
      JSON.stringify({
        type: 'session.start',
        node: 'test',
        session: sessionId,
        cwd: '/plain',
        prompt: 'p',
        worktree: true,
      }),
    );
    expect(await waitForFrame(conn, (f) => f.kind === 'node-error')).toMatchObject({
      session: sessionId,
      message: 'could not create a worktree: /plain is not a git repository',
    });
    expect(created).toHaveLength(0);
  });

  describe('closing a session', () => {
    async function started(extra: Partial<Parameters<typeof startNode>[0]> = {}) {
      createNode(extra);
      const conn = await nextConnection(harness, 0);
      await waitForFrame(conn, (f) => f.kind === 'hello');
      const sessionId = randomUUID();
      conn.socket.send(
        JSON.stringify({
          type: 'session.start',
          node: 'test',
          session: sessionId,
          cwd: '/r/.worktrees/abcd1234',
          prompt: 'p',
        }),
      );
      await waitForFrame(conn, (f) => f.type === 'session.started');
      return { conn, sessionId };
    }

    it('stops the process, removes the worktree when asked, and records session.closed', async () => {
      const removeWorktree = vi.fn(async () => ({ removed: true as const }));
      const { conn, sessionId } = await started({ removeWorktree });
      conn.socket.send(JSON.stringify({ type: 'session.close', session: sessionId, removeWorktree: true }));
      const closed = await waitForFrame(conn, (f) => f.type === 'session.closed');
      expect(closed).toMatchObject({ session: sessionId, payload: { worktree: { removed: true } } });
      expect(created[0]!.fake.close).toHaveBeenCalled();
      expect(removeWorktree).toHaveBeenCalledWith('/r/.worktrees/abcd1234');
    });

    it('leaves the worktree alone unless asked, and forgets the session either way', async () => {
      const removeWorktree = vi.fn();
      const { conn, sessionId } = await started({ removeWorktree });
      conn.socket.send(JSON.stringify({ type: 'session.close', session: sessionId }));
      expect(await waitForFrame(conn, (f) => f.type === 'session.closed')).toMatchObject({ payload: {} });
      expect(removeWorktree).not.toHaveBeenCalled();
      conn.socket.send(JSON.stringify({ type: 'session.send', session: sessionId, text: 'hi' }));
      expect(await waitForFrame(conn, (f) => f.kind === 'node-error')).toMatchObject({ session: sessionId });
    });

    it('closes a session it no longer holds, numbering after the hub-s events', async () => {
      createNode();
      const conn = await nextConnection(harness, 0);
      await waitForFrame(conn, (f) => f.kind === 'hello');
      const sessionId = randomUUID();
      conn.socket.send(
        JSON.stringify({ type: 'session.close', session: sessionId, resume: { cwd: '/w', nextSeq: 9 } }),
      );
      expect(await waitForFrame(conn, (f) => f.type === 'session.closed')).toMatchObject({
        session: sessionId,
        seq: 9,
      });
      expect(created).toHaveLength(0);
    });
  });

  it('sends hello first on connect', async () => {
    createNode();

    const conn = await nextConnection(harness, 0);
    await waitForFrame(conn, (f) => f.kind === 'hello');

    expect(conn.frames[0]).toEqual({ kind: 'hello', node: 'test', protocol: 1, sessions: [] });
  });

  it('names its release in hello when it knows one', async () => {
    createNode({ release: '0123456789ab' });
    const conn = await nextConnection(harness, 0);
    expect(await waitForFrame(conn, (f) => f.kind === 'hello')).toMatchObject({ release: '0123456789ab' });
  });

  it('creates a session on session.start and forwards events with increasing seq', async () => {
    createNode();
    const conn = await nextConnection(harness, 0);
    await waitForFrame(conn, (f) => f.kind === 'hello');

    const sessionId = randomUUID();
    conn.socket.send(
      JSON.stringify({
        type: 'session.start',
        node: 'test',
        session: sessionId,
        cwd: '/tmp/work',
        prompt: 'Fix the bug\nmore detail',
      }),
    );

    const started = await waitForFrame(conn, (f) => f.type === 'session.started');

    expect(sessionFactory).toHaveBeenCalledTimes(1);
    expect(created[0]!.opts).toEqual({
      session: sessionId,
      cwd: '/tmp/work',
      permissionUrl: `${PERMISSION_URL_BASE}/mcp/${sessionId}`,
      permissionMode: 'manual',
    });
    expect(created[0]!.fake.start).toHaveBeenCalledWith('Fix the bug\nmore detail');

    expect(started).toMatchObject({
      node: 'test',
      session: sessionId,
      seq: 0,
      type: 'session.started',
      payload: { cwd: '/tmp/work', prompt: 'Fix the bug\nmore detail', label: 'Fix the bug' },
    });
    expect(typeof started.ts).toBe('number');

    const fake = created[0]!.fake;
    fake.emit('event', { type: 'claude.event', payload: { engine: 'claude', raw: { hello: true } } });

    const claudeEnvelope = await waitForFrame(conn, (f) => f.type === 'claude.event');
    expect(claudeEnvelope).toMatchObject({
      session: sessionId,
      seq: 1,
      type: 'claude.event',
      payload: { engine: 'claude', raw: { hello: true } },
    });

    fake.emit('event', { type: 'session.ended', payload: { exitCode: 0, signal: null } });

    const endedEnvelope = await waitForFrame(conn, (f) => f.type === 'session.ended');
    expect(endedEnvelope).toMatchObject({
      session: sessionId,
      seq: 2,
      type: 'session.ended',
      payload: { exitCode: 0, signal: null },
    });
  });

  it('uses the first 60 chars of the prompt-s first line as the label', async () => {
    createNode();
    const conn = await nextConnection(harness, 0);
    await waitForFrame(conn, (f) => f.kind === 'hello');

    const sessionId = randomUUID();
    const longLine = 'x'.repeat(80);
    conn.socket.send(
      JSON.stringify({
        type: 'session.start',
        node: 'test',
        session: sessionId,
        cwd: '/tmp/work',
        prompt: `${longLine}\nsecond line`,
      }),
    );

    const started = await waitForFrame(conn, (f) => f.type === 'session.started');
    const payload = started.payload as { label: string };
    expect(payload.label).toBe(longLine.slice(0, 60));
    expect(payload.label).toHaveLength(60);
  });

  it('denies at once a permission request for a session it does not hold, sending nothing to the hub', async () => {
    createNode();
    const conn = await nextConnection(harness, 0);
    await waitForFrame(conn, (f) => f.kind === 'hello');
    const decision = await node!.handlePermissionRequest({
      session: randomUUID(),
      requestId: randomUUID(),
      toolName: 'Bash',
      input: {},
    });
    expect(decision.behavior).toBe('deny');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(conn.frames.some((f) => f.type === 'permission.request')).toBe(false);
  });

  it('turns a permission request into an envelope and resolves it on permission.answer (allow)', async () => {
    createNode();
    const conn = await nextConnection(harness, 0);
    await waitForFrame(conn, (f) => f.kind === 'hello');

    const sessionId = randomUUID();
    conn.socket.send(
      JSON.stringify({
        type: 'session.start',
        node: 'test',
        session: sessionId,
        cwd: '/tmp/work',
        prompt: 'do stuff',
      }),
    );
    await waitForFrame(conn, (f) => f.type === 'session.started');

    const requestId = randomUUID();
    const request: PermissionRequest = {
      session: sessionId,
      requestId,
      toolName: 'Bash',
      input: { command: 'ls' },
      toolUseId: 'tu1',
    };
    const decisionPromise = node!.handlePermissionRequest(request);

    const requestEnvelope = await waitForFrame(conn, (f) => f.type === 'permission.request');
    expect(requestEnvelope).toMatchObject({
      session: sessionId,
      seq: 1,
      type: 'permission.request',
      payload: { requestId, toolName: 'Bash', input: { command: 'ls' }, toolUseId: 'tu1' },
    });

    conn.socket.send(JSON.stringify({ type: 'permission.answer', session: sessionId, requestId, behavior: 'allow' }));

    const decision: PermissionDecision = await decisionPromise;
    expect(decision).toEqual({ behavior: 'allow' });

    const resolvedEnvelope = await waitForFrame(conn, (f) => f.type === 'permission.resolved');
    expect(resolvedEnvelope).toMatchObject({
      session: sessionId,
      seq: 2,
      type: 'permission.resolved',
      payload: { requestId, behavior: 'allow' },
    });
  });

  it('resolves a deny with the given message, defaulting when none is given', async () => {
    createNode();
    const conn = await nextConnection(harness, 0);
    await waitForFrame(conn, (f) => f.kind === 'hello');

    const sessionId = randomUUID();
    conn.socket.send(
      JSON.stringify({
        type: 'session.start',
        node: 'test',
        session: sessionId,
        cwd: '/tmp/work',
        prompt: 'do stuff',
      }),
    );
    await waitForFrame(conn, (f) => f.type === 'session.started');

    const requestIdWithMessage = randomUUID();
    const decisionWithMessage = node!.handlePermissionRequest({
      session: sessionId,
      requestId: requestIdWithMessage,
      toolName: 'Bash',
      input: {},
    });
    await waitForFrame(
      conn,
      (f) => f.type === 'permission.request' && (f.payload as { requestId: string }).requestId === requestIdWithMessage,
    );
    conn.socket.send(
      JSON.stringify({
        type: 'permission.answer',
        session: sessionId,
        requestId: requestIdWithMessage,
        behavior: 'deny',
        message: 'no thanks',
      }),
    );
    await expect(decisionWithMessage).resolves.toEqual({ behavior: 'deny', message: 'no thanks' });

    const requestIdNoMessage = randomUUID();
    const decisionNoMessage = node!.handlePermissionRequest({
      session: sessionId,
      requestId: requestIdNoMessage,
      toolName: 'Bash',
      input: {},
    });
    await waitForFrame(
      conn,
      (f) => f.type === 'permission.request' && (f.payload as { requestId: string }).requestId === requestIdNoMessage,
    );
    conn.socket.send(
      JSON.stringify({
        type: 'permission.answer',
        session: sessionId,
        requestId: requestIdNoMessage,
        behavior: 'deny',
      }),
    );
    await expect(decisionNoMessage).resolves.toEqual({ behavior: 'deny', message: 'Denied by user' });
  });

  async function startSession(conn: ConnRecorder): Promise<{ sessionId: string; fake: FakeSession }> {
    const sessionId = randomUUID();
    conn.socket.send(
      JSON.stringify({ type: 'session.start', node: 'test', session: sessionId, cwd: '/tmp/work', prompt: 'do stuff' }),
    );
    await waitForFrame(conn, (f) => f.type === 'session.started' && f.session === sessionId);
    const fake = created.find((c) => c.opts.session === sessionId)!.fake;
    return { sessionId, fake };
  }

  it('ignores a repeated session.start for a session it already has, answering with a node-error', async () => {
    createNode();
    const conn = await nextConnection(harness, 0);
    await waitForFrame(conn, (f) => f.kind === 'hello');
    const { sessionId, fake } = await startSession(conn);

    fake.emit('event', { type: 'claude.event', payload: { engine: 'claude', raw: { n: 1 } } });
    await waitForFrame(conn, (f) => f.type === 'claude.event' && f.seq === 1);

    const before = conn.frames.length;
    conn.socket.send(
      JSON.stringify({ type: 'session.start', node: 'test', session: sessionId, cwd: '/tmp/work', prompt: 'again' }),
    );
    const nodeError = await waitForNewFrame(conn, before, (f) => f.kind === 'node-error');
    expect(nodeError).toEqual({
      kind: 'node-error',
      session: sessionId,
      message: `session already exists: ${sessionId}`,
    });
    expect(sessionFactory).toHaveBeenCalledTimes(1);
    expect(fake.start).toHaveBeenCalledTimes(1);
    expect(conn.frames.filter((f) => f.type === 'session.started')).toHaveLength(1);

    // seq keeps counting on the original session state.
    fake.emit('event', { type: 'claude.event', payload: { engine: 'claude', raw: { n: 2 } } });
    const next = await waitForFrame(
      conn,
      (f) => f.type === 'claude.event' && (f.payload as { raw: { n: number } }).raw.n === 2,
    );
    expect(next.seq).toBe(2);
  });

  it('denies a pending permission request when its session ends, and ignores a late answer', async () => {
    createNode();
    const conn = await nextConnection(harness, 0);
    await waitForFrame(conn, (f) => f.kind === 'hello');
    const { sessionId, fake } = await startSession(conn);
    const { sessionId: otherId } = await startSession(conn);

    const requestId = randomUUID();
    const decision = node!.handlePermissionRequest({ session: sessionId, requestId, toolName: 'Bash', input: {} });
    const otherRequestId = randomUUID();
    let otherSettled = false;
    const otherDecision = node!
      .handlePermissionRequest({ session: otherId, requestId: otherRequestId, toolName: 'Bash', input: {} })
      .then((d) => {
        otherSettled = true;
        return d;
      });
    await waitForFrame(
      conn,
      (f) => f.type === 'permission.request' && (f.payload as { requestId: string }).requestId === otherRequestId,
    );

    fake.emit('event', { type: 'session.ended', payload: { exitCode: 0, signal: null } });

    await expect(decision).resolves.toEqual({ behavior: 'deny', message: 'Session ended before an answer' });
    const resolved = await waitForFrame(conn, (f) => f.type === 'permission.resolved' && f.session === sessionId);
    expect(resolved.payload).toEqual({ requestId, behavior: 'deny' });

    // The other session's request is untouched.
    await delay(50);
    expect(otherSettled).toBe(false);

    // A late answer for the expired request is ignored: no second permission.resolved.
    conn.socket.send(JSON.stringify({ type: 'permission.answer', session: sessionId, requestId, behavior: 'allow' }));
    await delay(100);
    const resolvedFrames = conn.frames.filter(
      (f) => f.type === 'permission.resolved' && (f.payload as { requestId: string }).requestId === requestId,
    );
    expect(resolvedFrames).toHaveLength(1);

    conn.socket.send(
      JSON.stringify({ type: 'permission.answer', session: otherId, requestId: otherRequestId, behavior: 'allow' }),
    );
    await expect(otherDecision).resolves.toEqual({ behavior: 'allow' });
  });

  it('denies every pending permission request when the node closes', async () => {
    createNode();
    const conn = await nextConnection(harness, 0);
    await waitForFrame(conn, (f) => f.kind === 'hello');
    const { sessionId } = await startSession(conn);

    const requestId = randomUUID();
    const decision = node!.handlePermissionRequest({ session: sessionId, requestId, toolName: 'Bash', input: {} });
    await waitForFrame(conn, (f) => f.type === 'permission.request');

    node!.close();

    const result = await Promise.race([decision, delay(500).then(() => 'still pending' as const)]);
    expect(result).toEqual({ behavior: 'deny', message: 'Session ended before an answer' });
  });

  it('routes session.send and session.interrupt to the matching session', async () => {
    createNode();
    const conn = await nextConnection(harness, 0);
    await waitForFrame(conn, (f) => f.kind === 'hello');

    const sessionId = randomUUID();
    conn.socket.send(
      JSON.stringify({
        type: 'session.start',
        node: 'test',
        session: sessionId,
        cwd: '/tmp/work',
        prompt: 'do stuff',
      }),
    );
    await waitForFrame(conn, (f) => f.type === 'session.started');
    const fake = created[0]!.fake;

    conn.socket.send(JSON.stringify({ type: 'session.send', session: sessionId, text: 'follow up' }));
    await waitUntil(() => fake.send.mock.calls.length > 0);
    expect(fake.send).toHaveBeenCalledWith('follow up');

    conn.socket.send(JSON.stringify({ type: 'session.interrupt', session: sessionId }));
    await waitUntil(() => fake.interrupt.mock.calls.length > 0);
    expect(fake.interrupt).toHaveBeenCalledTimes(1);
  });

  it('records a follow-up as a user.message envelope before forwarding it to the session', async () => {
    createNode();
    const conn = await nextConnection(harness, 0);
    await waitForFrame(conn, (f) => f.kind === 'hello');

    const sessionId = randomUUID();
    conn.socket.send(
      JSON.stringify({ type: 'session.start', node: 'test', session: sessionId, cwd: '/tmp/work', prompt: 'do stuff' }),
    );
    await waitForFrame(conn, (f) => f.type === 'session.started');
    const fake = created[0]!.fake;
    // Anything the session emits while handling the send must come after the user.message.
    fake.send.mockImplementation(() => {
      fake.emit('event', { type: 'claude.event', payload: { engine: 'claude', raw: { during: 'send' } } });
    });

    conn.socket.send(JSON.stringify({ type: 'session.send', session: sessionId, text: 'follow up' }));

    const userMessage = await waitForFrame(conn, (f) => f.type === 'user.message');
    const during = await waitForFrame(conn, (f) => f.type === 'claude.event');
    expect(userMessage).toMatchObject({
      session: sessionId,
      seq: 1,
      type: 'user.message',
      payload: { text: 'follow up' },
    });
    expect(during).toMatchObject({ seq: 2 });
    expect(fake.send).toHaveBeenCalledWith('follow up');
  });

  it('rebuilds a session it no longer has from a send that carries resume, continuing the hub-s seq', async () => {
    createNode();
    const conn = await nextConnection(harness, 0);
    await waitForFrame(conn, (f) => f.kind === 'hello');

    const sessionId = randomUUID();
    conn.socket.send(
      JSON.stringify({
        type: 'session.send',
        session: sessionId,
        text: 'still there?',
        resume: { cwd: '/tmp/old', nextSeq: 42 },
      }),
    );

    const userMessage = await waitForFrame(conn, (f) => f.type === 'user.message');
    expect(userMessage).toMatchObject({ session: sessionId, seq: 42, payload: { text: 'still there?' } });
    expect(created[0]!.opts).toEqual({
      session: sessionId,
      cwd: '/tmp/old',
      permissionUrl: `${PERMISSION_URL_BASE}/mcp/${sessionId}`,
      permissionMode: 'manual',
    });
    expect(created[0]!.fake.start).not.toHaveBeenCalled();
    expect(created[0]!.fake.send).toHaveBeenCalledWith('still there?');

    created[0]!.fake.emit('event', { type: 'claude.event', payload: { engine: 'claude', raw: { n: 1 } } });
    expect(await waitForFrame(conn, (f) => f.type === 'claude.event')).toMatchObject({ seq: 43 });
  });

  it('rebuilds a session on the engine its resume names', async () => {
    createNode({ engines: ['stream', 'interactive'] });
    const conn = await nextConnection(harness, 0);
    await waitForFrame(conn, (f) => f.kind === 'hello');
    const sessionId = randomUUID();
    conn.socket.send(
      JSON.stringify({
        type: 'session.send',
        session: sessionId,
        text: 'still there?',
        resume: { cwd: '/tmp/old', nextSeq: 7, engine: 'interactive' },
      }),
    );
    await waitForFrame(conn, (f) => f.type === 'user.message');
    expect(created[0]!.opts).toMatchObject({ session: sessionId, cwd: '/tmp/old', engine: 'interactive' });
    expect(created[0]!.fake.send).toHaveBeenCalledWith('still there?');
  });

  it('refuses to rebuild a session on an engine it no longer runs, starting nothing', async () => {
    createNode();
    const conn = await nextConnection(harness, 0);
    await waitForFrame(conn, (f) => f.kind === 'hello');
    const sessionId = randomUUID();
    conn.socket.send(
      JSON.stringify({
        type: 'session.send',
        session: sessionId,
        text: 'hi',
        resume: { cwd: '/tmp/old', nextSeq: 7, engine: 'interactive' },
      }),
    );
    expect(await waitForFrame(conn, (f) => f.kind === 'node-error')).toMatchObject({ session: sessionId });
    expect(created).toHaveLength(0);
  });

  it('answers a command for an unknown session with a node-error frame, not an envelope that could collide on seq', async () => {
    createNode();
    const conn = await nextConnection(harness, 0);
    await waitForFrame(conn, (f) => f.kind === 'hello');

    const unknownId = randomUUID();
    expect(() =>
      conn.socket.send(JSON.stringify({ type: 'session.send', session: unknownId, text: 'hi' })),
    ).not.toThrow();

    const nodeError = await waitForFrame(conn, (f) => f.kind === 'node-error' && f.session === unknownId);
    expect(nodeError).toEqual({ kind: 'node-error', session: unknownId, message: `unknown session: ${unknownId}` });
    expect(conn.frames.some((f) => f.type === 'error')).toBe(false);
    expect(sessionFactory).not.toHaveBeenCalled();

    // The connection is still alive and keeps handling further commands afterward.
    const frameCountBefore = conn.frames.length;
    expect(() => conn.socket.send(JSON.stringify({ type: 'session.interrupt', session: unknownId }))).not.toThrow();
    const second = await waitForNewFrame(
      conn,
      frameCountBefore,
      (f) => f.kind === 'node-error' && f.session === unknownId,
    );
    expect(second).toBeDefined();
    expect(conn.frames.some((f) => f.type === 'error')).toBe(false);
  });

  it('drops malformed JSON and unrecognized frames from the hub without throwing', async () => {
    createNode();
    const conn = await nextConnection(harness, 0);
    await waitForFrame(conn, (f) => f.kind === 'hello');

    expect(() => conn.socket.send('not json {{{')).not.toThrow();
    expect(() => conn.socket.send(JSON.stringify({ totally: 'unrecognized' }))).not.toThrow();

    // The link still works afterward: a well-formed command gets a normal response.
    const unknownId = randomUUID();
    conn.socket.send(JSON.stringify({ type: 'session.interrupt', session: unknownId }));
    const nodeError = await waitForFrame(conn, (f) => f.kind === 'node-error' && f.session === unknownId);
    expect(nodeError).toBeDefined();
  });

  describe('reconnection', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('reconnects 1s after the server drops the socket and resends unacked envelopes', async () => {
      createNode();
      const conn0 = await nextConnection(harness, 0);
      await waitForFrame(conn0, (f) => f.kind === 'hello');

      const sessionId = randomUUID();
      conn0.socket.send(
        JSON.stringify({
          type: 'session.start',
          node: 'test',
          session: sessionId,
          cwd: '/tmp/work',
          prompt: 'do stuff',
        }),
      );
      const started = await waitForFrame(conn0, (f) => f.type === 'session.started');
      expect(started.seq).toBe(0);
      // Never ack it: it must come back after reconnecting.

      conn0.socket.terminate();
      await delay(100); // let the node's client socket notice the drop (real I/O, unaffected by fake timers)

      vi.advanceTimersByTime(999);
      await delay(20);
      expect(harness.connections).toHaveLength(1); // no reconnect attempt yet

      vi.advanceTimersByTime(1); // now at 1000ms since the drop
      const conn1 = await nextConnection(harness, 1);
      const hello2 = await waitForFrame(conn1, (f) => f.kind === 'hello');
      // It also tells the hub which sessions it still holds, so the hub can release the rest.
      expect(hello2).toEqual({ kind: 'hello', node: 'test', protocol: 1, sessions: [sessionId] });

      const resent = await waitForFrame(conn1, (f) => f.type === 'session.started');
      expect(resent).toEqual(started);
    });

    it('backs off 1s, 2s, 4s, 8s, 16s then caps at 30s on repeated failed connections, and resets after a success', async () => {
      harness.rejectNextConnections = 6; // attempts 0-5 fail outright; attempt 6 succeeds
      createNode();

      await delay(50); // attempt 0 (immediate)
      expect(harness.rejectNextConnections).toBe(5);
      expect(harness.connections).toHaveLength(0);

      const delays = [1000, 2000, 4000, 8000, 16000, 30000];
      for (const [i, ms] of delays.entries()) {
        vi.advanceTimersByTime(ms - 1);
        await delay(15);
        expect(harness.connections).toHaveLength(0); // no success yet

        vi.advanceTimersByTime(1);
        await delay(40);

        if (i < delays.length - 1) {
          // attempts 1-5: still rejected
          expect(harness.rejectNextConnections).toBe(5 - (i + 1));
          expect(harness.connections).toHaveLength(0);
        }
      }

      // The final attempt (after the 30s-capped wait) succeeds.
      const conn = await nextConnection(harness, 0);
      await waitForFrame(conn, (f) => f.kind === 'hello');
      expect(harness.connections).toHaveLength(1);

      // Backoff resets to 1s after that successful connect.
      conn.socket.terminate();
      await delay(100);

      vi.advanceTimersByTime(999);
      await delay(20);
      expect(harness.connections).toHaveLength(1);

      vi.advanceTimersByTime(1);
      const conn2 = await nextConnection(harness, 1);
      await waitForFrame(conn2, (f) => f.kind === 'hello');
      expect(harness.connections).toHaveLength(2);
    }, 10000);
  });
});
