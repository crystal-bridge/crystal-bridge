import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import {
  ClientMessage,
  Envelope,
  FileReply,
  HubAck,
  type HubCliUpdate,
  type HubKingdomVersion,
  type SelfUpdate,
  type HubToClient,
  NodeCommand,
  NodeCli,
  NodeCliUpdated,
  NodeSelfUpdate,
  NodeError,
  NodeExternal,
  NodeProjects,
  NodeHello,
  PROTOCOL_VERSION,
  PushSubscriptionPut,
  Appearance,
  type Attention,
  type ExternalSession,
  type Project,
  Engine,
} from '@crystal-bridge/protocol';
import { type Authenticator, cookieHeader } from './auth.js';
import type { FirstRun } from './first-run.js';
import { cleanHubName, type HubSettings } from './hub-settings.js';
import { createJoinCodes } from './join.js';
import { isNodeId, type NodeRegistry } from './nodes.js';
import type { Pusher } from './push.js';
import type { Store } from './store.js';

export interface BuildServerOptions {
  store: Store;
  /** Fastify's own request logging; off by default so tests stay quiet. */
  logger?: boolean;
  /**
   * Node tokens. When set, `/node` refuses a connection without a valid bearer token, and a node must
   * say hello as the id its token was issued to. Without it any local process can act as any node.
   */
  nodes?: NodeRegistry;
  /**
   * Who may use the client side (the web app, `/api` and `/client`). `/node` is left to node tokens and `/api/health`
   * stays open. Unset, the client side is open, for `pnpm dev`.
   */
  auth?: Authenticator;
  /** On a token-login hub that started with no logins: what lets the first one be made. */
  firstRun?: FirstRun;
  /** The hub's own settings; without them it has no name. */
  settings?: HubSettings;
  /** The Kingdom release to name to Kingdoms that update themselves. Unset: they're left where they are. */
  kingdomVersion?: string;
  /** This release's id (the deployed commit), reported by /api/health so open tabs can tell they're outdated. */
  release?: string;
  /** The built web app; by default where a checkout builds it. */
  webRoot?: string;
  /** Finds the latest agent CLI version, for "update available". Unset: the hub doesn't check. */
  latestCli?: () => Promise<string | undefined>;
  /** How often relayed-byte counts are written to the store (default 30 s); they're also written on close. */
  relayFlushMs?: number;
  /** Web Push: the VAPID public key browsers subscribe with, and what sends each attention to subscribed devices. */
  push?: { publicKey: string; pusher: Pusher };
}

/** Tokens and codes can't be guessed, but each try costs a file read: a limit for the routes that take one. */
const GUESSES = { max: 20, timeWindow: '1 minute' };

/** Higher, for a whole fleet reconnecting after a hub restart. */
const NODE_DIALS = { max: 300, timeWindow: '1 minute' };

/** Close code for a node whose hello names a protocol version this hub doesn't speak. */
const CLOSE_WRONG_PROTOCOL = 4006;

/** Close code for a node whose token was just revoked. */
const CLOSE_TOKEN_REVOKED = 4007;

/** How long the file viewer waits for a node's answer before telling the client it didn't come. */
const FILE_TIMEOUT_MS = 15_000;
/** A little past the node's own limit on the update, so the node's answer normally comes first. */
const CLI_UPDATE_WAIT_MS = 6 * 60 * 1000;

/**
 * Sends an error and, for a refused WebSocket upgrade, closes the connection afterwards: an upgrade
 * request has no response cycle to end it, so the socket would otherwise stay open and keep the server
 * from closing.
 */
async function refuse(request: FastifyRequest, reply: FastifyReply, code: number, error: string): Promise<void> {
  if (request.headers.upgrade) reply.raw.once('finish', () => request.raw.socket.destroy());
  await reply.code(code).header('connection', 'close').send({ error });
}

/**
 * Paths that don't need a logged-in user: node links and leaving use a node's token, joining and first-run setup use
 * a one-time code, logging in is how you become one, and health checks carry no data.
 */
const OPEN_PATHS = new Set([
  '/node',
  '/api/health',
  '/api/join',
  '/api/leave',
  '/api/me',
  '/api/login',
  '/api/logout',
  '/api/setup',
]);

/** Close code for a node whose hello names a different node than its token. */
const CLOSE_WRONG_NODE = 4003;

function bearer(header: string | undefined): string | undefined {
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
}

/** One subscriber's cursor into one session's event stream. */
interface Subscription {
  socket: WebSocket;
  /** Highest seq already sent to this socket for this session; live events at or below it are skipped. */
  lastSeq: number;
}

/** How many stored events go in one replay frame. */
const REPLAY_BATCH = 500;

function rawType(envelope: Envelope): unknown {
  if (envelope.type !== 'claude.event' || typeof envelope.payload !== 'object' || envelope.payload === null) return;
  const raw = (envelope.payload as { raw?: unknown }).raw;
  return typeof raw === 'object' && raw !== null ? (raw as { type?: unknown }).type : undefined;
}

/**
 * A replay without the streaming fragments (`stream_event`) of turns that have finished: each turn's full messages
 * carry the same text, and the fragments are most of a long session's events. Fragments after the last `result`
 * belong to a turn still in progress and stay, so its reply keeps streaming in.
 */
function withoutFinishedFragments(events: readonly Envelope[]): Envelope[] {
  let lastResult = -1;
  for (const event of events) if (rawType(event) === 'result') lastResult = event.seq;
  return events.filter((event) => event.seq > lastResult || rawType(event) !== 'stream_event');
}

function sendJson(socket: WebSocket, data: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(data));
  }
}

function sendToClient(socket: WebSocket, message: HubToClient): void {
  sendJson(socket, message);
}

/** Sends a frame about one session; returns its size in bytes (0 when the socket is gone). */
function sendSessionFrame(socket: WebSocket, message: HubToClient): number {
  if (socket.readyState !== socket.OPEN) return 0;
  const json = JSON.stringify(message);
  socket.send(json);
  return Buffer.byteLength(json);
}

function parseFrame(data: unknown): unknown | undefined {
  try {
    return JSON.parse(String(data));
  } catch {
    return undefined;
  }
}

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const {
    store,
    logger = false,
    nodes: registry,
    auth,
    firstRun,
    settings,
    release = 'dev',
    latestCli,
    kingdomVersion,
    webRoot,
    push,
    relayFlushMs = 30_000,
  } = options;
  const app = fastify({ logger });
  // Only on the doors anyone can knock at, by route. Not on the whole API: behind a proxy every request shares an address,
  // so a global limit would throttle the app's own polling.
  await app.register(rateLimit, { global: false });

  /** Whose request this is; one shared user when there's no login (pnpm dev, where the client side is open anyway). */
  const loginOf = (request: FastifyRequest): string => auth?.identify(request) ?? 'default';

  if (auth) {
    app.addHook('onRequest', async (request, reply) => {
      const path = request.url.split('?', 1)[0]!;
      if (OPEN_PATHS.has(path)) return;
      if (auth.publicApp && !path.startsWith('/api/') && path !== '/client') return;
      if (auth.identify(request)) return;
      app.log.warn({ url: request.url }, 'refused a request from a user who is not allowed');
      await refuse(request, reply, 403, auth.refusal);
    });
  }

  // Connected nodes, keyed by the id each one gave in its `hello` frame.
  const nodes = new Map<string, WebSocket>();
  // Live subscribers, keyed by session id.
  const subscriptions = new Map<string, Subscription[]>();
  // Each node's latest list of sessions its engine ran outside the bridge.
  const external = new Map<string, ExternalSession[]>();
  // Each node's project folders, for the New session picker.
  const projects = new Map<string, Project[]>();
  // The engines each node said in hello it can run sessions on, for the New session picker.
  const engines = new Map<string, Engine[]>();
  // The release each node said in hello, for the Castle.
  const releases = new Map<string, string>();
  // How each Kingdom's move to `kingdomVersion` is going, for the Castle. Gone once it reconnects.
  const selfUpdates = new Map<string, SelfUpdate>();
  // The agent CLI version each node last reported, for the Castle.
  const cliVersions = new Map<string, string>();
  // Nodes whose hello said they can run the agent CLI's update; older ones would never answer.
  const cliUpdaters = new Set<string>();
  // The update each node is running, by node: one at a time, and only that node's answer ends it.
  const cliUpdates = new Map<
    string,
    { requestId: string; timer: NodeJS.Timeout; finish: (answer: { version?: string; error?: string }) => void }
  >();
  // Every connected client, for errors that aren't about one session.
  const clients = new Set<WebSocket>();
  // Each client's tailnet login, so a user's appearance change reaches only their own other tabs.
  const clientLogins = new Map<WebSocket, string>();
  // File viewer requests in flight: who asked, and which node may answer. An answer from anyone else goes nowhere.
  const fileRequests = new Map<string, { client: WebSocket; node: string; timer: NodeJS.Timeout }>();

  function answerFile(client: WebSocket, requestId: string, reason: string): void {
    sendToClient(client, { kind: 'file', requestId, ok: false, reason });
  }

  /** A `file.read` goes to the session's node with the store's folder, never a client's; its answer to this client. */
  function handleFileRead(client: WebSocket, command: Extract<NodeCommand, { type: 'file.read' }>): void {
    const session = store.getSession(command.session);
    if (!session) return answerFile(client, command.requestId, `unknown session: ${command.session}`);
    const nodeSocket = nodes.get(session.node);
    if (!nodeSocket) return answerFile(client, command.requestId, 'that Kingdom is offline');
    if (fileRequests.has(command.requestId)) return answerFile(client, command.requestId, 'duplicate request');
    const timer = setTimeout(() => {
      fileRequests.delete(command.requestId);
      answerFile(client, command.requestId, 'the Kingdom did not answer in time');
    }, FILE_TIMEOUT_MS);
    timer.unref();
    fileRequests.set(command.requestId, { client, node: session.node, timer });
    sendJson(nodeSocket, { ...command, cwd: session.cwd });
  }

  // Bytes sent to clients per session since the last flush; written in one batch, never per frame.
  let relayed = new Map<string, number>();
  function relay(socket: WebSocket, session: string, message: HubToClient): void {
    const bytes = sendSessionFrame(socket, message);
    if (bytes) relayed.set(session, (relayed.get(session) ?? 0) + bytes);
  }
  function flushRelayed(): void {
    if (relayed.size === 0) return;
    const pending = relayed;
    relayed = new Map();
    try {
      store.addRelayed(pending);
    } catch (error) {
      // A throw from the timer would take the whole hub down; keep the counts for the next flush instead.
      for (const [session, bytes] of pending) relayed.set(session, (relayed.get(session) ?? 0) + bytes);
      app.log.warn({ error }, 'could not write relay counts; will retry');
    }
  }
  const relayTimer = setInterval(flushRelayed, relayFlushMs);
  relayTimer.unref();
  app.addHook('onClose', async () => {
    clearInterval(relayTimer);
    flushRelayed();
  });

  function broadcast(envelope: Envelope): void {
    const subs = subscriptions.get(envelope.session);
    if (!subs) return;
    for (const sub of subs) {
      if (envelope.seq <= sub.lastSeq) continue;
      sub.lastSeq = envelope.seq;
      relay(sub.socket, envelope.session, { kind: 'event', event: envelope });
    }
  }

  /** What a stored event means for the user's attention, if anything: needs them, finished a turn, or failed. */
  function attentionFor(envelope: Envelope): Attention | undefined {
    const payload = (
      typeof envelope.payload === 'object' && envelope.payload !== null ? envelope.payload : {}
    ) as Record<string, unknown>;
    let reason: Attention['reason'];
    let detail: string | undefined;
    if (envelope.type === 'permission.request') {
      reason = 'needs-you';
      detail = typeof payload.toolName === 'string' ? payload.toolName : undefined;
    } else if (envelope.type === 'terminal.screen' && payload.raised === true) {
      reason = 'needs-you';
      detail = 'Terminal';
    } else if (envelope.type === 'turn.finished' && payload.outcome !== 'interrupted') {
      reason = payload.outcome === 'success' ? 'done' : 'failed';
      detail = typeof payload.summary === 'string' ? payload.summary : undefined;
    } else if (envelope.type === 'session.ended' && payload.reason === 'error') {
      reason = 'failed';
    } else {
      return undefined;
    }
    const label = store.getSession(envelope.session)?.label ?? '';
    const frame: Attention = { kind: 'attention', node: envelope.node, session: envelope.session, label, reason };
    if (detail !== undefined) frame.detail = detail;
    return frame;
  }

  /** Sends an error to a session's subscribers, or to every client when there is no session. */
  function broadcastError(session: string | undefined, message: string): void {
    const targets = session === undefined ? [...clients] : (subscriptions.get(session) ?? []).map((sub) => sub.socket);
    for (const socket of new Set(targets)) sendToClient(socket, { kind: 'error', message });
  }

  function removeSubscriber(socket: WebSocket): void {
    for (const [session, subs] of subscriptions) {
      const remaining = subs.filter((sub) => sub.socket !== socket);
      if (remaining.length > 0) {
        subscriptions.set(session, remaining);
      } else {
        subscriptions.delete(session);
      }
    }
  }

  function handleSubscribe(socket: WebSocket, session: string, fromSeq: number): void {
    const sub: Subscription = { socket, lastSeq: fromSeq - 1 };
    // A second subscribe from the same socket replaces its first, so the client never gets each event twice.
    const subs = (subscriptions.get(session) ?? []).filter((existing) => existing.socket !== socket);
    subs.push(sub);
    subscriptions.set(session, subs);

    // Register the subscriber first, then replay: both happen synchronously in this handler,
    // so no live event can slip in between (see Task 8 notes on replay-then-live).
    const stored = store.eventsSince(session, fromSeq);
    for (const event of stored) if (event.seq > sub.lastSeq) sub.lastSeq = event.seq;
    const replay = withoutFinishedFragments(stored);
    for (let i = 0; i < replay.length; i += REPLAY_BATCH) {
      relay(socket, session, {
        kind: 'events',
        session,
        events: replay.slice(i, i + REPLAY_BATCH),
        total: replay.length,
      });
    }
    relay(socket, session, { kind: 'synced', session, seq: sub.lastSeq });
  }

  function routeToNode(clientSocket: WebSocket, nodeId: string, command: NodeCommand): void {
    const nodeSocket = nodes.get(nodeId);
    if (!nodeSocket) {
      sendToClient(clientSocket, { kind: 'error', message: 'node offline' });
      return;
    }
    sendJson(nodeSocket, command);
  }

  function handleCommand(clientSocket: WebSocket, command: NodeCommand): void {
    if (command.type === 'file.read') return handleFileRead(clientSocket, command);
    if (command.type === 'session.start' || command.type === 'session.adopt') {
      if (store.getSession(command.session)) {
        sendToClient(clientSocket, { kind: 'error', message: `session already exists: ${command.session}` });
        return;
      }
      if (command.type === 'session.start' && command.forkFrom) {
        // A fork runs where its source did: the store's node and folder, never the client's, and no new worktree.
        const source = store.getSession(command.forkFrom);
        if (!source) {
          sendToClient(clientSocket, { kind: 'error', message: `unknown session: ${command.forkFrom}` });
          return;
        }
        const { worktree: _worktree, ...fork } = command;
        routeToNode(clientSocket, source.node, { ...fork, node: source.node, cwd: source.cwd });
        return;
      }
      routeToNode(clientSocket, command.node, command);
      return;
    }

    const session = store.getSession(command.session);
    if (!session) {
      sendToClient(clientSocket, { kind: 'error', message: `unknown session: ${command.session}` });
      return;
    }
    if (command.type === 'session.send' || command.type === 'session.close') {
      // Always the store's values, so a client can't point a node at another directory.
      const engine = store.sessionEngine(command.session);
      const effort = store.sessionEffort(command.session);
      const resume = {
        cwd: session.cwd,
        nextSeq: store.nextSeq(command.session),
        ...(engine ? { engine } : {}),
        ...(effort ? { effort } : {}),
      };
      routeToNode(clientSocket, session.node, { ...command, resume });
      return;
    }
    routeToNode(clientSocket, session.node, command);
  }

  // Awaited so the plugin's `onRoute` hook (which recognizes `{ websocket: true }`) is
  // wired up before the routes below are added; otherwise they're added as plain HTTP routes.
  await app.register(fastifyWebsocket);

  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDist = webRoot ?? path.resolve(here, '../../web/dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
  }

  // Open to monitors (no login): connected node ids are codenames, not content.
  app.get('/api/health', async () => ({ ok: true, release, protocol: PROTOCOL_VERSION, nodes: [...nodes.keys()] }));
  // Unflushed relay counts are added in, so the figure is current between flushes.
  app.get('/api/sessions', async () =>
    store.listSessions().map((s) => ({ ...s, relayedBytes: s.relayedBytes + (relayed.get(s.id) ?? 0) })),
  );
  app.get('/api/nodes', async () => [...nodes.keys()]);
  // Who holds a token, connected or not: a Kingdom with Quests that isn't here has been removed.
  app.get('/api/nodes/enrolled', async () => registry?.ids() ?? []);
  const secure = (request: FastifyRequest): boolean =>
    request.protocol === 'https' || request.headers['x-forwarded-proto'] === 'https';
  app.get('/api/me', async (request) => ({
    login: auth ? (auth.identify(request) ?? null) : 'default',
    canLogIn: auth?.login !== undefined,
    setup: firstRun?.pending() ?? false,
  }));
  app.get('/api/hub', async () => ({ name: settings?.name() ?? null }));
  app.put('/api/hub', async (request, reply) => {
    const { name } = (request.body ?? {}) as { name?: unknown };
    const clean = typeof name === 'string' ? cleanHubName(name) : undefined;
    if (clean === undefined) return reply.code(400).send({ error: 'use at most 40 characters, on one line' });
    settings?.setName(clean || undefined);
    return reply.code(204).send();
  });
  // First-run setup: the code from the logs makes the first login, which also logs this browser in.
  app.post('/api/setup', { config: { rateLimit: GUESSES } }, async (request, reply) => {
    if (!firstRun?.pending()) return reply.code(409).send({ error: 'this hub is already set up' });
    const { code, name } = (request.body ?? {}) as { code?: unknown; name?: unknown };
    if (typeof name !== 'string' || !isNodeId(name)) {
      return reply.code(400).send({ error: 'use letters, digits and dashes for the name' });
    }
    const token = typeof code === 'string' ? firstRun.claim(code, name) : undefined;
    if (!token) return reply.code(401).send({ error: 'that setup code is wrong' });
    void reply.header('set-cookie', cookieHeader(token, { secure: secure(request) }));
    return { login: name, token };
  });
  app.post('/api/login', { config: { rateLimit: GUESSES } }, async (request, reply) => {
    if (!auth?.login) return reply.code(404).send({ error: 'this hub has no login page' });
    const { token } = (request.body ?? {}) as { token?: unknown };
    const login = typeof token === 'string' ? auth.login(token) : undefined;
    if (!login) return reply.code(401).send({ error: 'that token is not valid' });
    void reply.header('set-cookie', cookieHeader(token as string, { secure: secure(request) }));
    return { login };
  });
  app.post('/api/logout', async (request, reply) =>
    reply
      .header('set-cookie', cookieHeader('', { secure: secure(request), clear: true }))
      .code(204)
      .send(),
  );
  const joinCodes = createJoinCodes();
  // Adding a Kingdom: only for a new node, so a code can't be used to take over one that already has a token.
  app.post('/api/join-codes', async (request, reply) => {
    const { node } = (request.body ?? {}) as { node?: unknown };
    if (!registry) return reply.code(409).send({ error: 'this hub has no node tokens' });
    if (typeof node !== 'string' || !isNodeId(node)) return reply.code(400).send({ error: 'expected { node }' });
    if (registry.ids().includes(node)) return reply.code(409).send({ error: 'that name is taken' });
    return joinCodes.issue(node);
  });
  app.post('/api/join', { config: { rateLimit: GUESSES } }, async (request, reply) => {
    const { code } = (request.body ?? {}) as { code?: unknown };
    if (typeof code !== 'string') return reply.code(400).send({ error: 'expected { code }' });
    const node = joinCodes.redeem(code);
    if (!node || !registry) return reply.code(401).send({ error: 'that code is wrong, used or expired' });
    if (registry.ids().includes(node)) return reply.code(409).send({ error: 'that name is taken' });
    return { node, token: registry.issue(node) };
  });
  // The Kingdom's own uninstall: it gives up its token, so nobody needs to remove it from the app as well.
  app.post('/api/leave', { config: { rateLimit: GUESSES } }, async (request, reply) => {
    const node = registry?.verify(bearer(request.headers.authorization));
    if (!node) return reply.code(401).send({ error: 'missing or invalid node token' });
    registry!.revoke(node);
    nodes.get(node)?.close(CLOSE_TOKEN_REVOKED, 'node token revoked');
    return reply.code(204).send();
  });
  // Removing a Kingdom: its token stops working now, and so does a connection made with it. Its Quests stay as history.
  app.delete('/api/nodes/:node', async (request, reply) => {
    const { node } = request.params as { node: string };
    if (!registry?.revoke(node)) return reply.code(404).send({ error: 'no such node token' });
    nodes.get(node)?.close(CLOSE_TOKEN_REVOKED, 'node token revoked');
    return reply.code(204).send();
  });
  // Updating a Kingdom's agent CLI: the node runs the CLI's own update, and refuses while a Quest there is busy.
  app.post('/api/nodes/:node/cli-update', async (request, reply) => {
    const { node } = request.params as { node: string };
    const socket = nodes.get(node);
    if (!socket) return reply.code(404).send({ error: 'that Kingdom is offline' });
    if (!cliUpdaters.has(node))
      return reply.code(409).send({ error: 'update this Kingdom first: it is too old for this' });
    if (cliUpdates.has(node)) return reply.code(409).send({ error: 'an update is already running' });
    const requestId = randomUUID();
    const answer = await new Promise<{ version?: string; error?: string }>((resolve) => {
      const finish = (result: { version?: string; error?: string }) => {
        clearTimeout(cliUpdates.get(node)?.timer);
        cliUpdates.delete(node);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ error: 'the Kingdom did not answer in time' }), CLI_UPDATE_WAIT_MS);
      cliUpdates.set(node, { requestId, timer, finish });
      sendJson(socket, { kind: 'cli-update', requestId } satisfies HubCliUpdate);
    });
    if (answer.error !== undefined) return reply.code(409).send({ error: answer.error });
    return answer.version ? { version: answer.version } : {};
  });
  // Forgetting a Kingdom: deletes the hub's copy of its Quests for good, so only one that was removed first.
  app.delete('/api/nodes/:node/quests', async (request, reply) => {
    const { node } = request.params as { node: string };
    if (nodes.has(node) || registry?.ids().includes(node)) {
      return reply.code(409).send({ error: 'remove this Kingdom first' });
    }
    for (const session of store.forgetNode(node)) {
      relayed.delete(session);
      subscriptions.delete(session);
    }
    engines.delete(node);
    return reply.code(204).send();
  });
  app.get('/api/usage', async () => store.latestUsage());
  // Found sessions, minus any the hub already hosts (bridge sessions leave transcripts on the node too).
  // One node at a time, so a search never pulls another Kingdom's content into view.
  app.get('/api/search', async (request, reply) => {
    const { node, q } = request.query as { node?: string; q?: string };
    if (!node) return reply.code(400).send({ error: 'node is required' });
    const query = (q ?? '').trim();
    return query.length < 2 ? [] : store.search(node, query, 100);
  });
  // Web Push: a device subscribes with its prefs, and PUTs again whenever they change, so pushes follow them.
  app.get('/api/push/key', async (_request, reply) =>
    push ? { publicKey: push.publicKey } : reply.code(404).send({ error: 'push is not set up on this hub' }),
  );
  app.put('/api/push/subscription', async (request, reply) => {
    const body = PushSubscriptionPut.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'expected { subscription, prefs }' });
    store.putPushSubscription(body.data.subscription, body.data.prefs);
    return reply.code(204).send();
  });
  app.delete('/api/push/subscription', async (request, reply) => {
    const { endpoint } = (request.body ?? {}) as { endpoint?: unknown };
    if (typeof endpoint !== 'string') return reply.code(400).send({ error: 'expected { endpoint }' });
    store.deletePushSubscription(endpoint);
    return reply.code(204).send();
  });
  // Kingdom appearance: one per user, shared by their devices; a change reaches their other open tabs at once.
  app.get('/api/appearance', async (request) => store.getAppearance(loginOf(request)) ?? {});
  app.put('/api/appearance', async (request, reply) => {
    const body = Appearance.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'expected { looks?, tabStyle? }' });
    const login = loginOf(request);
    store.putAppearance(login, body.data);
    for (const [socket, owner] of clientLogins) {
      if (owner === login) sendToClient(socket, { kind: 'appearance', appearance: body.data });
    }
    return reply.code(204).send();
  });
  app.get('/api/waiting', async () => store.waiting());
  app.get('/api/cli-latest', async () => {
    const latest = await latestCli?.();
    return latest ? { latest } : {};
  });
  app.get('/api/projects', async () => [...projects].map(([node, list]) => ({ node, projects: list })));
  app.get('/api/engines', async () =>
    [...engines]
      .filter(([node]) => nodes.has(node))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([node, list]) => {
        const nodeRelease = releases.get(node);
        const cli = cliVersions.get(node);
        const selfUpdate = selfUpdates.get(node);
        return {
          node,
          engines: list,
          ...(nodeRelease ? { release: nodeRelease } : {}),
          ...(cli ? { cli } : {}),
          ...(cliUpdaters.has(node) ? { cliUpdate: true } : {}),
          ...(selfUpdate ? { selfUpdate } : {}),
        };
      }),
  );
  // Home-page data: turn totals per node since a time the client picks (its own midnight, its week), and recent
  // activity. Both read engine-neutral turn.finished / session lifecycle events only.
  app.get('/api/stats', async (request, reply) => {
    const since = Number((request.query as { since?: string }).since);
    if (!Number.isFinite(since)) return reply.code(400).send({ error: 'since must be epoch milliseconds' });
    return store.turnStats(since);
  });
  // Every Quest's lifetime battles, for the client's levels (#23); also engine-neutral.
  app.get('/api/xp', async () => store.questXp());
  app.get('/api/activity', async (request) => {
    const limit = Number((request.query as { limit?: string }).limit);
    return store.activity(Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 30);
  });
  app.get('/api/external', async () =>
    [...external].map(([node, sessions]) => ({ node, sessions: sessions.filter((s) => !store.getSession(s.id)) })),
  );

  app.get(
    '/node',
    {
      websocket: true,
      config: { rateLimit: NODE_DIALS },
      preValidation: async (request, reply) => {
        if (registry && !registry.verify(bearer(request.headers.authorization))) {
          await refuse(request, reply, 401, 'missing or invalid node token');
        }
      },
    },
    (socket, request) => {
      // Set when tokens are on: the only node id this connection may claim.
      const tokenNode = registry?.verify(bearer(request.headers.authorization));
      let helloNode: string | null = null;

      socket.on('message', (data) => {
        const parsed = parseFrame(data);
        if (parsed === undefined) {
          app.log.warn('dropped malformed JSON frame from node');
          return;
        }

        if (helloNode === null) {
          const hello = NodeHello.safeParse(parsed);
          if (!hello.success) {
            app.log.warn('dropped frame from node before hello');
            return;
          }
          const protocol = hello.data.protocol ?? 1;
          if (protocol !== PROTOCOL_VERSION) {
            const reason = `protocol v${protocol} not supported; this hub speaks v${PROTOCOL_VERSION}`;
            app.log.warn({ node: hello.data.node }, reason);
            socket.close(CLOSE_WRONG_PROTOCOL, reason);
            return;
          }
          if (registry && hello.data.node !== tokenNode) {
            app.log.warn(
              { claimed: hello.data.node, token: tokenNode },
              'closed a node whose hello does not match its token',
            );
            socket.close(CLOSE_WRONG_NODE, 'hello does not match token');
            return;
          }
          helloNode = hello.data.node;
          const existing = nodes.get(helloNode);
          nodes.set(helloNode, socket);
          if (existing && existing !== socket) existing.close();
          // Only engines this hub knows: a newer node may offer more.
          const known = (hello.data.engines ?? []).flatMap((name) => {
            const parsed = Engine.safeParse(name);
            return parsed.success ? [parsed.data] : [];
          });
          engines.set(helloNode, known.length > 0 ? known : ['stream']);
          if (hello.data.release) releases.set(helloNode, hello.data.release);
          else releases.delete(helloNode);
          if (hello.data.cliUpdate) cliUpdaters.add(helloNode);
          else cliUpdaters.delete(helloNode);
          selfUpdates.delete(helloNode);
          if (hello.data.selfUpdate) {
            sendJson(socket, {
              kind: 'kingdom-version',
              ...(kingdomVersion ? { version: kingdomVersion } : {}),
            } satisfies HubKingdomVersion);
          }
          // A node that lists what it holds lets us release sessions whose process died with it.
          if (hello.data.sessions) {
            const released = store.releaseOrphans(helloNode, hello.data.sessions);
            if (released.length > 0) app.log.info({ node: helloNode, released }, 'marked orphaned sessions idle');
          }
          return;
        }

        const cli = NodeCli.safeParse(parsed);
        if (cli.success) {
          cliVersions.set(helloNode, cli.data.version);
          return;
        }

        const selfUpdate = NodeSelfUpdate.safeParse(parsed);
        if (selfUpdate.success) {
          const { version, state, reason } = selfUpdate.data;
          selfUpdates.set(helloNode, { version, state, ...(reason ? { reason } : {}) });
          return;
        }

        const cliUpdated = NodeCliUpdated.safeParse(parsed);
        if (cliUpdated.success) {
          const running = cliUpdates.get(helloNode);
          if (running?.requestId !== cliUpdated.data.requestId) {
            app.log.warn({ node: helloNode }, 'dropped a CLI update answer nobody is waiting for from this node');
            return;
          }
          const { ok, version, reason } = cliUpdated.data;
          if (version) cliVersions.set(helloNode, version);
          running.finish(ok ? (version ? { version } : {}) : { error: reason ?? 'the update failed' });
          return;
        }

        const listed = NodeProjects.safeParse(parsed);
        if (listed.success) {
          projects.set(helloNode, listed.data.projects);
          return;
        }

        const found = NodeExternal.safeParse(parsed);
        if (found.success) {
          external.set(helloNode, found.data.sessions);
          return;
        }

        const file = FileReply.safeParse(parsed);
        if (file.success) {
          const pending = fileRequests.get(file.data.requestId);
          if (!pending || pending.node !== helloNode) {
            app.log.warn({ node: helloNode }, 'dropped a file answer nobody is waiting for from this node');
            return;
          }
          fileRequests.delete(file.data.requestId);
          clearTimeout(pending.timer);
          sendToClient(pending.client, file.data);
          return;
        }

        const nodeError = NodeError.safeParse(parsed);
        if (nodeError.success) {
          app.log.warn({ node: helloNode, session: nodeError.data.session }, nodeError.data.message);
          broadcastError(nodeError.data.session, nodeError.data.message);
          return;
        }

        const envelope = Envelope.safeParse(parsed);
        if (!envelope.success) {
          app.log.warn('dropped unrecognized frame from node');
          return;
        }
        if (envelope.data.node !== helloNode) {
          app.log.warn('dropped envelope whose node differs from its hello');
          return;
        }

        const { session, seq, type } = envelope.data;
        // A node may only add to its own sessions. Ack it anyway, or the node resends it forever.
        const owner = store.getSession(session)?.node;
        if (owner !== undefined && owner !== helloNode) {
          app.log.warn({ node: helloNode, owner, session }, 'dropped an envelope for another node-s session');
          sendJson(socket, { kind: 'ack', session, seq } satisfies HubAck);
          return;
        }
        let inserted = false;
        let failed = false;
        try {
          inserted = store.appendEvent(envelope.data);
        } catch (error) {
          // It will never succeed, so ack it anyway; otherwise the node resends it forever.
          failed = true;
          app.log.error({ error, session, seq, type }, 'failed to append event with a bad payload');
        }

        sendJson(socket, { kind: 'ack', session, seq } satisfies HubAck);

        if (failed) {
          broadcastError(session, `dropped a ${type} event (seq ${seq}) with a bad payload`);
          return;
        }

        if (inserted) {
          broadcast(envelope.data);
          const attention = attentionFor(envelope.data);
          if (attention) {
            for (const client of clients) sendToClient(client, attention);
            push?.pusher.notify(attention).catch((error: unknown) => app.log.warn({ error }, 'Web Push failed'));
          }
        }
      });

      socket.on('close', () => {
        if (helloNode !== null && nodes.get(helloNode) === socket) {
          nodes.delete(helloNode);
          // What it reported is stale now: Recruit and New Quest mustn't offer an offline node's lists.
          external.delete(helloNode);
          projects.delete(helloNode);
          releases.delete(helloNode);
          cliVersions.delete(helloNode);
          cliUpdaters.delete(helloNode);
          selfUpdates.delete(helloNode);
          cliUpdates.get(helloNode)?.finish({ error: 'the Kingdom went offline during the update' });
        }
      });
    },
  );

  app.get('/client', { websocket: true }, (socket, request) => {
    clients.add(socket);
    clientLogins.set(socket, loginOf(request));
    socket.on('message', (data) => {
      const parsed = parseFrame(data);
      if (parsed === undefined) {
        app.log.warn('dropped malformed JSON frame from client');
        return;
      }

      const message = ClientMessage.safeParse(parsed);
      if (!message.success) {
        app.log.warn('dropped unrecognized frame from client');
        return;
      }

      if (message.data.kind === 'subscribe') {
        handleSubscribe(socket, message.data.session, message.data.fromSeq);
      } else {
        handleCommand(socket, message.data.command);
      }
    });

    socket.on('close', () => {
      clients.delete(socket);
      clientLogins.delete(socket);
      for (const [requestId, pending] of fileRequests) {
        if (pending.client !== socket) continue;
        clearTimeout(pending.timer);
        fileRequests.delete(requestId);
      }
      removeSubscriber(socket);
    });
  });

  return app;
}
