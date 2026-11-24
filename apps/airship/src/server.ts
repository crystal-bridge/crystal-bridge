import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import { z } from 'zod';
import {
  ClientMessage,
  HEARTBEAT_MS,
  Envelope,
  FileReply,
  HubAck,
  type HubCliUpdate,
  HubListInventory,
  type HubKingdomVersion,
  type SelfUpdate,
  type HubToClient,
  NodeCast,
  NodeCommand,
  NodeCli,
  NodeCliUpdated,
  NodeInventoryListed,
  NodeSelfUpdate,
  NodeError,
  NodeExternal,
  NodeProjects,
  NodeHello,
  NodeSummons,
  BoardAct,
  BoardQuest,
  BoardItemsChange,
  type HubScoutAction,
  type HubScoutQuest,
  type HubScoutRunNow,
  NodeScoutActed,
  ScoutItem,
  NodeScoutRun,
  NodeScouts,
  type HubPatrolChange,
  type HubPatrolDraft,
  type HubPatrolPreview,
  type HubPatrolRunNow,
  NodePatrolChanged,
  NodePatrolDrafted,
  NodePatrolPreviewed,
  PatrolDraftRequest,
  type PatrolDraft,
  NodePatrolRun,
  NodePatrols,
  PatrolChangeRequest,
  PatrolPreviewRequest,
  PatrolId,
  PatrolRunMark,
  type Cast,
  type Resume,
  type Summon,
  PONG_FRAME,
  PROTOCOL_VERSION,
  isOlderVersion,
  keepBeating,
  PushSubscriptionPut,
  Appearance,
  type Attention,
  type ExternalSession,
  type Project,
  Engine,
  MAX_QUEST_TITLE,
  QuestTitle,
  ErrandCreate,
  ErrandEdit,
  ErrandStateChange,
  MAX_ERRAND_BODY,
  MAX_OPEN_ERRANDS,
  ErrandProject,
  type Deed,
  HubLibraryBacklinks,
  type HubLibraryList,
  HubLibraryRead,
  HubLibraryWrite,
  type LibraryInfo,
  LibraryPath,
  MAX_IMAGE_BYTES,
  MAX_TOME_BYTES,
  NodeLibraryAnswer,
  NodeLibraryChanged,
  TomeVersion,
} from '@crystal-bridge/protocol';
import { type Authenticator, cookieHeader } from './auth.js';
import type { FirstRun } from './first-run.js';
import type { CheckOutcome } from './cli-release.js';
import type { LatestRelease } from './hub-release.js';
import type { UpdateStatus } from './updater.js';
import { cleanHubName, type HubSettings } from './hub-settings.js';
import { deedIdFor } from './deeds.js';
import { createJoinCodes } from './join.js';
import { isNodeId, type NodeRegistry } from './nodes.js';
import type { Pusher } from './push.js';
import { BadEvent, type SessionRow, type Store } from './store.js';

export interface BuildServerOptions {
  store: Store;
  /** How often to check each Kingdom is still there and its token still good. Default `HEARTBEAT_MS`. */
  nodeHeartbeatMs?: number;
  /** How often to check each open tab is still there and its login still good. Default `HEARTBEAT_MS`. */
  clientHeartbeatMs?: number;
  /** How much may wait to go out to one tab before it's dropped. Default `MAX_CLIENT_BACKLOG`. */
  clientBacklogBytes?: number;
  /** How long a second Crystal on a node id is left waiting before it's closed. Default `DUPLICATE_HOLD_MS`. */
  duplicateHoldMs?: number;
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
  /** Finds this project's latest release, for the Ship's Log. Unset: the hub doesn't check. */
  latestRelease?: () => Promise<LatestRelease | undefined>;
  /** Check for updates: asks GitHub now, within the checker's limit, and says how it went. Unset: no button. */
  checkReleaseNow?: () => Promise<CheckOutcome>;
  /** When `latestRelease` last got an answer from GitHub, for the Ship's Log. */
  releaseCheckedAt?: () => number | undefined;
  /**
   * The hub's updater, when one runs beside it (a packaged hub under systemd, docs/OPERATIONS.md): `request` names the
   * release to install, and `status` says how the last one went. Without it the Ship's Log says how to update by hand.
   */
  hubUpdates?: { request: (version: string) => void; status: () => UpdateStatus | undefined };
  /** What this hub can say about its database and backups, for the Ship's Log. */
  upkeep?: () => { databaseBytes?: number; lastBackupAt?: number; lastMirrorAt?: number };
  /** How often relayed-byte counts are written to the store (default 30 s); they're also written on close. */
  relayFlushMs?: number;
  /** How often closed Errands past ERRANDS_KEPT_MS are deleted; once at start too. Default one hour. */
  errandPurgeMs?: number;
  /** How long a finished Cast waits for others, so Casts ending together give their Quest one wake-up. Default 2 s. */
  wakeDelayMs?: number;
  /** Web Push: the VAPID public key browsers subscribe with, and what sends each attention to subscribed devices. */
  push?: { publicKey: string; pusher: Pusher };
  /**
   * Test only: the CSP an HTML Tome is served into the app's frame with, in place of `LIBRARY_PAGE_CSP`. It lets the
   * browser gate build a hub with a wrong policy and see the page refused. Never set it outside a test.
   */
  libraryPageCsp?: string;
}

/** Tokens and codes can't be guessed, but each try costs a file read: a limit for the routes that take one. */
const GUESSES = { max: 20, timeWindow: '1 minute' };

/** Higher, for a whole fleet reconnecting after a hub restart. */
const NODE_DIALS = { max: 300, timeWindow: '1 minute' };

/**
 * Whether a browser sent this for a page from another site. It brings the login along (a `tailscale serve` identity
 * comes from the device, and a dev hub has none), and only reads are safe from that, because the browser won't show
 * the page the answer. Fetch metadata comes first since a proxy may rewrite Host. No Origin means no browser sent it.
 */
function fromAnotherSite(headers: FastifyRequest['headers']): boolean {
  const site = headers['sec-fetch-site'];
  if (site) return site !== 'same-origin' && site !== 'none';
  if (headers.origin === undefined) return false;
  const host = headers['x-forwarded-host'] ?? headers.host;
  return !URL.canParse(headers.origin) || new URL(headers.origin).host !== host;
}

/** Close code for a node whose hello names a protocol version this hub doesn't speak. */
const CLOSE_WRONG_PROTOCOL = 4006;

/** Close code for a node whose token was revoked or replaced. */
const CLOSE_TOKEN_REVOKED = 4007;

/** Close code for a tab whose login has been removed. */
const CLOSE_LOGIN_REVOKED = 4008;

/** Close code for a node whose id another Crystal holds and is still answering on: a clone, or a leftover service. */
const CLOSE_DUPLICATE_NODE = 4009;

/**
 * Every Kingdom redials a second after any close, and older ones can't be told otherwise, since connecting resets their
 * backoff. So a second Crystal is held, unanswered, this long first: that's the backoff, and it's the hub's own doing.
 */
const DUPLICATE_HOLD_MS = 30_000;

/** Most tabs never get near this. One that does has stopped reading, and catches up by `fromSeq` when it reconnects. */
const MAX_CLIENT_BACKLOG = 32 * 1024 * 1024;

/** How long the file viewer waits for a node's answer before telling the client it didn't come. */
const FILE_TIMEOUT_MS = 15_000;
/** A little past the node's own limit on the update, so the node's answer normally comes first. */
const CLI_UPDATE_WAIT_MS = 6 * 60 * 1000;

/** A Kingdom's answer to a Board action, a Patrol change or a preview; `refused` marks a reason the Kingdom gave. */
interface KingdomAnswer {
  ok: boolean;
  reason?: string;
  session?: string;
  times?: number[];
  draft?: PatrolDraft;
  refused?: boolean;
  /** A Library request's whole answer, for the route to pass on. */
  library?: NodeLibraryAnswer;
}
/** A Kingdom lists within 15 seconds or says it can't, so this only meets one that stopped answering. */
const INVENTORY_WAIT_MS = 20_000;
/** How long a Board's quest or run action waits for its Kingdom: a script there may take two minutes. */
const SCOUT_ACTION_WAIT_MS = 150_000;
/** How long a Library request waits for its Kingdom, as the file viewer's do: reading a file takes no script. */
const LIBRARY_WAIT_MS = 15_000;
/** A write carries up to `MAX_TOME_BYTES` of text, which JSON escaping can make up to six times longer. */
const LIBRARY_BODY_LIMIT = MAX_TOME_BYTES * 6 + 64 * 1024;
/** A Tome write as the app sends it. */
const TomeWrite = z.object({
  path: LibraryPath,
  content: HubLibraryWrite.shape.content,
  base: TomeVersion.nullable(),
});

/** The longest Kingdom name a tab may ask to watch. */
const MAX_NODE_ID = 200;

/**
 * The headers on every Library answer, refusals included, replacing the hub's usual CSP: a Tome is the Kingdom's text,
 * so nothing in an answer may run, sniff its way into another type, or be read by another site (docs/LIBRARY.md,
 * "Mind the wards"). The JSON routes take this CSP; a route that serves a file itself sets its own after this.
 */
function libraryHeaders(reply: FastifyReply, csp = "sandbox; default-src 'none'"): FastifyReply {
  return reply
    .header('content-security-policy', csp)
    .header('x-content-type-options', 'nosniff')
    .header('cross-origin-resource-policy', 'same-origin');
}

/** How many image reads may be in flight to one Kingdom, so a page of pictures can't hold up approvals on its link. */
const LIBRARY_IMAGE_SLOTS = 2;
/**
 * The content type of each image a Library serves, by extension. The hub sets it from this table alone, never from
 * the Kingdom's answer, so a Kingdom can't pass HTML off as an image.
 */
const LIBRARY_IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};
/** An SVG may style itself but runs no script and loads nothing, even opened directly at the hub's address. */
const LIBRARY_SVG_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'";

/**
 * An HTML Tome in the app's frame: its scripts run with an opaque origin, it loads nothing, and only the app may frame
 * it (docs/LIBRARY.md, "Open the sealed pages"). It replaces the hub's usual CSP, so `frame-ancestors 'none'` is gone.
 */
const LIBRARY_PAGE_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; frame-ancestors 'self'";
const LIBRARY_PAGE_EXTENSIONS = new Set(['html', 'htm']);

/** Whether the browser fetched this to show in a frame on one of the hub's own pages. */
function forTheAppsFrame(headers: FastifyRequest['headers']): boolean {
  return headers['sec-fetch-dest'] === 'iframe' && headers['sec-fetch-site'] === 'same-origin';
}

/** A Library path's extension, lower-cased, or '' when it has none. */
function libraryExtension(file: string): string {
  const name = file.slice(file.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** The HTTP status for a Kingdom's refused Library request: a stale write or a taken path is a conflict, a missing file is not found. */
function libraryRefusalStatus(reason: string | undefined): number {
  return reason === 'not in the Library' || reason === 'gone' ? 404 : 409;
}

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

/**
 * Agent text and repository files are shown in the app, so images may load only from the hub or the page itself, or a
 * stray `<img>` could carry data out with no tool call. The app's sprites, icons and favicons all come from here.
 */
const CONTENT_SECURITY_POLICY = "img-src 'self' data: blob:; frame-ancestors 'none'";

/**
 * The page Mermaid draws in (docs/LIBRARY.md, "Read the Tomes"), replacing the hub's usual CSP: `sandbox allow-scripts`
 * gives it an opaque origin, so a flaw in Mermaid can't run script in the app; it runs only the app's own scripts, loads
 * nothing else, and only the app may frame it.
 */
const MERMAID_FRAME_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'";

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

/** Sends a frame about one session; returns its size in bytes (0 when the socket is gone). */
function sendSessionFrame(socket: WebSocket, message: HubToClient): number {
  if (socket.readyState !== socket.OPEN) return 0;
  const json = JSON.stringify(message);
  socket.send(json);
  return Buffer.byteLength(json);
}

/** How many Casts the Summoning Circle gets. */
const CASTS_SHOWN = 50;
/** How much of each log a wake-up carries. */
const WAKE_TAIL = 1500;

const CAST_ENDS: Record<Cast['state'], string> = {
  running: 'is running',
  succeeded: 'finished',
  failed: 'failed',
  cancelled: 'was cancelled',
  lost: 'was lost: its process is gone and no result was recorded, and it has not been retried',
};

/** A terminal's colour, cursor and title codes. */
const TERMINAL_CODES = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-_])/g;

/**
 * What a job wrote, made fit to quote in a message. Control and invisible characters go first, since they can hide a
 * fence, and then no fence is left that could close ours and let a log pass for words from Crystal Bridge.
 */
function quotable(text: string): string {
  return text
    .replace(TERMINAL_CODES, '')
    .replace(/\r\n?|[\p{Zl}\p{Zp}]/gu, '\n')
    .replace(/[\p{Cc}\p{Cf}]/gu, (char) => (char === '\n' || char === '\t' ? char : ''))
    .replace(/`{3,}/g, (fence) => "'".repeat(fence.length));
}

/** The message that wakes a Quest. It says who sent it, since it arrives as a follow-up. */
export function wakeText(casts: readonly Cast[]): string {
  const parts = casts.map((cast) => {
    const code = cast.exitCode === undefined ? '' : ` (exit ${cast.exitCode})`;
    const name = quotable(cast.name).replace(/\s+/g, ' ').trim().replaceAll('"', "'");
    const tail = quotable(cast.logTail).trimEnd().slice(-WAKE_TAIL);
    const log = tail ? `\nThe end of its log:\n\`\`\`\n${tail}\n\`\`\`` : '';
    return `Cast "${name}" on ${cast.summon} ${CAST_ENDS[cast.state]}${code}. Its id is ${cast.id}.${log}`;
  });
  return `[Crystal Bridge, not the user: you asked to be woken when this finished.]\n\n${parts.join('\n\n')}`;
}

/** What a Quest is told when it comes back from being cut off, which is also how a second cut in a row is known. */
export const REVIVE_TEXT =
  '[Crystal Bridge, not the user: this machine’s Crystal restarted while your last turn was running, so that turn ' +
  'stopped there.]\n\nAny tool call in progress ended with it, and may show only a bare kill code. Check what really ' +
  'finished, then carry on from there, without repeating work that did.';

/** How long after a cut a Quest still comes back by itself. Later than this, nobody may want it to. */
const REVIVE_WINDOW_MS = 30 * 60_000;

function parseFrame(data: unknown): unknown | undefined {
  try {
    return JSON.parse(String(data));
  } catch {
    return undefined;
  }
}

/** Longer than airship-update.service's TimeoutStartSec: an install this quiet has stopped. */
const INSTALL_QUIET_MS = 20 * 60_000;

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
    latestRelease,
    releaseCheckedAt,
    checkReleaseNow,
    hubUpdates,
    upkeep,
    kingdomVersion,
    webRoot,
    push,
    relayFlushMs = 30_000,
    errandPurgeMs = 60 * 60 * 1000,
    wakeDelayMs = 2000,
    nodeHeartbeatMs = HEARTBEAT_MS,
    clientHeartbeatMs = HEARTBEAT_MS,
    clientBacklogBytes = MAX_CLIENT_BACKLOG,
    duplicateHoldMs = DUPLICATE_HOLD_MS,
    libraryPageCsp = LIBRARY_PAGE_CSP,
  } = options;
  const app = fastify({ logger });
  /**
   * For work outside any request: a socket event or a timer. A throw there is uncaught and ends the hub, and every link
   * with it, so a failed write (a full disk, say) costs what it was doing and no more.
   */
  const guarded =
    <Args extends unknown[]>(what: string, work: (...args: Args) => void) =>
    (...args: Args): void => {
      try {
        work(...args);
      } catch (error) {
        app.log.error({ err: error }, `${what} failed`);
      }
    };
  /** The release to name to Kingdoms now: the hub's own, or under approvals the last approved, never past the hub's. */
  const namedVersion = (): string | undefined => {
    const choice = settings?.kingdomUpdates();
    if (!kingdomVersion || choice?.mode !== 'approved' || !choice.approved) return kingdomVersion;
    return isOlderVersion(choice.approved, kingdomVersion) ? choice.approved : kingdomVersion;
  };
  /**
   * How the last install went, with one that went quiet past the updater's own time limit read as stopped: a reboot or a
   * kill mid-install leaves its last word, and the Ship's Log would otherwise wait on it for good. A failed one drops
   * the Kingdom approval it was to bring.
   */
  const installProgress = (): UpdateStatus | undefined => {
    const progress = hubUpdates?.status();
    if (!progress) return undefined;
    const busy = progress.state === 'installing' || progress.state === 'restarting';
    const seen =
      busy && Date.now() - progress.at > INSTALL_QUIET_MS
        ? {
            ...progress,
            state: 'failed' as const,
            reason: `the updater stopped partway, with no word for ${INSTALL_QUIET_MS / 60_000} minutes; try again`,
          }
        : progress;
    if (seen.state === 'failed') settings?.takeKingdomApproval(seen.version);
    return seen;
  };
  // Install updates asked for this release with Kingdoms waiting for approval: now it runs, approve them to it.
  if (settings && kingdomVersion && settings.takeKingdomApproval(release)) {
    if (settings.kingdomUpdates().mode === 'approved') {
      settings.setKingdomUpdates({ mode: 'approved', approved: kingdomVersion });
    }
  }
  // Only on the doors anyone can knock at, by route. Not on the whole API: behind a proxy every request shares an address,
  // so a global limit would throttle the app's own polling.
  await app.register(rateLimit, { global: false });

  /** Whose request this is; one shared user when there's no login (pnpm dev, where the client side is open anyway). */
  const loginOf = (request: FastifyRequest): string => auth?.identify(request) ?? 'default';

  // On every answer, refusals and misses included: what's left of an exfiltrating image if a client ever renders one.
  app.addHook('onRequest', async (_request, reply) => {
    void reply.header('content-security-policy', CONTENT_SECURITY_POLICY);
  });

  app.addHook('onRequest', async (request, reply) => {
    const changes = request.method !== 'GET' && request.method !== 'HEAD';
    if ((changes || request.routeOptions.url === '/client') && fromAnotherSite(request.headers)) {
      app.log.warn({ url: request.url, origin: request.headers.origin }, 'refused a request from another site');
      await refuse(request, reply, 403, 'refused: this request came from another site');
    }
  });

  if (auth) {
    app.addHook('onRequest', async (request, reply) => {
      // The route the router matched, not the raw URL: it decodes the path, so `/%61pi/sessions` reaches `/api/sessions`.
      const path = request.routeOptions.url ?? request.url.split('?', 1)[0]!;
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
  const summons = new Map<string, Summon[]>();
  /** Casts that ended and will wake their Quest together, by Quest. */
  const wakes = new Map<string, { casts: Map<string, Cast>; timer: NodeJS.Timeout }>();
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
  // Kingdoms that update themselves, to tell when the version to run changes.
  const selfUpdaters = new Set<string>();
  const nameVersion = (socket: WebSocket): void => {
    const version = namedVersion();
    sendJson(socket, { kind: 'kingdom-version', ...(version ? { version } : {}) } satisfies HubKingdomVersion);
  };
  const announceVersion = (): void => {
    for (const node of selfUpdaters) {
      const socket = nodes.get(node);
      if (socket) nameVersion(socket);
    }
  };
  // The update each node is running, by node: one at a time, and only that node's answer ends it.
  const cliUpdates = new Map<
    string,
    { requestId: string; timer: NodeJS.Timeout; finish: (answer: { version?: string; error?: string }) => void }
  >();
  // Nodes that can list an Inventory before a Quest, and the lists in flight: only the asked node's answer ends one.
  const inventoryListers = new Set<string>();
  // Nodes that run Scouts, so can be asked to run one now.
  const scoutNodes = new Set<string>();
  /** Kingdoms that start a Quest from Board items with the user's prompt (`HubScoutQuest`). */
  const scoutQuestNodes = new Set<string>();
  /** Kingdoms that answer `patrol-draft` ("Patrol this" on a Board). */
  const patrolDraftNodes = new Set<string>();
  const deedsNodes = new Set<string>();
  /** Kingdoms that keep a Library, and where (docs/LIBRARY.md). */
  const libraryNodes = new Map<string, LibraryInfo>();
  /** Each Kingdom's image reads: how many are in flight, and who waits for a slot, first come first served. */
  const libraryImageSlots = new Map<string, { busy: number; waiting: ((got: boolean) => void)[] }>();
  /** Kingdoms that run Patrols, and those of them that take Patrols from the app (docs/PATROLS.md). */
  const patrolNodes = new Set<string>();
  const patrolEditNodes = new Set<string>();
  /** Kingdoms that work out a schedule's next run times for the Patrol form. */
  const patrolPreviewNodes = new Set<string>();
  const inventoryLists = new Map<
    string,
    { node: string; finish: (events: NodeInventoryListed['events'], error?: string) => void }
  >();
  // Board actions and Patrol changes in flight, by request: only the asked node's answer ends one.
  const kingdomAsks = new Map<string, { node: string; finish: (answer: KingdomAnswer) => void }>();
  // Every connected client, for errors that aren't about one session.
  const clients = new Set<WebSocket>();
  /** The tabs with a Kingdom's Library open, by Kingdom; kept while it is offline, so a tab hears when it returns. */
  const libraryWatchers = new Map<string, Set<WebSocket>>();
  // Each client's tailnet login, so a user's appearance change reaches only their own other tabs.
  const clientLogins = new Map<WebSocket, string>();
  // File viewer requests in flight: who asked, and which node may answer. An answer from anyone else goes nowhere.
  const fileRequests = new Map<string, { client: WebSocket; node: string; timer: NodeJS.Timeout }>();
  // When each node socket was last heard from, to tell a live Crystal from a link that died without a close.
  const lastHeard = new WeakMap<WebSocket, number>();
  // What a replay left queued for each tab: a long Quest's can pass the limit alone, and the tab is owed time to read it.
  const replayBacklog = new WeakMap<WebSocket, number>();

  /** Whether a node socket is a live Crystal. One answers every beat, so this can't miss one that's just quiet. */
  const stillAnswering = (socket: WebSocket): boolean =>
    socket.readyState === socket.OPEN && Date.now() - (lastHeard.get(socket) ?? 0) < nodeHeartbeatMs * 1.5;

  /** Ends a tab's socket when frames pile up faster than it reads, since they'd otherwise sit in the hub's memory. */
  function dropIfBehind(socket: WebSocket): void {
    const backlog = socket.bufferedAmount;
    if (backlog <= clientBacklogBytes) {
      replayBacklog.delete(socket);
    } else if (backlog > clientBacklogBytes + (replayBacklog.get(socket) ?? 0)) {
      app.log.warn({ login: clientLogins.get(socket), backlog }, 'a tab fell too far behind, dropping it');
      socket.terminate();
    }
  }

  function sendToClient(socket: WebSocket, message: HubToClient): void {
    sendJson(socket, message);
    dropIfBehind(socket);
  }

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
  function purgeErrands(): void {
    try {
      for (const node of store.purgeErrands(Date.now())) sendErrands(node);
    } catch (error) {
      // A throw from the timer would take the whole hub down; the next run tries again.
      app.log.warn({ error }, 'could not delete old Errands; will retry');
    }
  }
  purgeErrands();
  const errandTimer = setInterval(purgeErrands, errandPurgeMs);
  errandTimer.unref();
  app.addHook('onClose', async () => {
    clearInterval(relayTimer);
    clearInterval(errandTimer);
    flushRelayed();
    for (const { timer } of wakes.values()) clearTimeout(timer);
  });

  function broadcast(envelope: Envelope): void {
    const subs = subscriptions.get(envelope.session);
    if (!subs) return;
    for (const sub of subs) {
      if (envelope.seq <= sub.lastSeq) continue;
      sub.lastSeq = envelope.seq;
      relay(sub.socket, envelope.session, { kind: 'event', event: envelope });
      dropIfBehind(sub.socket);
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
    } else if (envelope.type === 'session.ended' && payload.reason === 'restart' && payload.resuming !== true) {
      reason = 'failed';
      detail = 'Cut off by a restart';
    } else {
      return undefined;
    }
    const quest = store.getSession(envelope.session);
    const frame: Attention = {
      kind: 'attention',
      node: envelope.node,
      session: envelope.session,
      label: quest?.label ?? '',
      ...(quest?.plainLabel ? { plainLabel: quest.plainLabel } : {}),
      reason,
    };
    if (detail !== undefined) frame.detail = detail;
    if (reason === 'done' && envelope.type === 'turn.finished') {
      const left = store.errandsLeftInTurn(envelope.session, envelope.seq);
      if (left > 0) frame.errands = left;
    }
    return frame;
  }

  function notifyCast(node: string, cast: Cast): void {
    const quest = store.getSession(cast.session);
    const attention: Attention = {
      kind: 'attention',
      node,
      session: cast.session,
      label: quest?.label ?? '',
      ...(quest?.plainLabel ? { plainLabel: quest.plainLabel } : {}),
      reason: cast.state === 'succeeded' ? 'cast-done' : 'cast-failed',
      detail: `${cast.name} on ${cast.summon}`,
    };
    for (const client of clients) sendToClient(client, attention);
    push?.pusher.notify(attention).catch((error: unknown) => app.log.warn({ error }, 'Web Push failed'));
  }

  /** Sends a Quest one message for the Casts that ended together. Undelivered ones go again on the node's next connect. */
  /** What a node needs to rebuild a session it doesn't hold, always from the store. */
  function resumeOf(session: SessionRow): Resume {
    const engine = store.sessionEngine(session.id);
    const effort = store.sessionEffort(session.id);
    const mode = store.sessionMode(session.id);
    return {
      cwd: session.cwd,
      nextSeq: store.nextSeq(session.id),
      ...(engine ? { engine } : {}),
      ...(effort ? { effort } : {}),
      ...(mode ? { mode } : {}),
    };
  }

  function wakeQuest(node: string, session: string, casts: readonly Cast[]): void {
    const socket = nodes.get(node);
    const quest = store.getSession(session);
    if (!socket || !quest || quest.status === 'closed') return;
    const send: NodeCommand = { type: 'session.send', session, text: wakeText(casts), resume: resumeOf(quest) };
    // Recorded first: a wake costs a turn, and one sent but not recorded goes again on the node's next connect.
    for (const cast of casts) store.markCastDelivered(cast.id);
    sendJson(socket, send);
  }

  /**
   * A node said hello without a session whose turn never finished, so its process went with the node. Records that, so
   * nothing goes on showing it as working, and brings it back with word of what happened. Only once in a row, because
   * a Quest whose own turn restarts its node would otherwise go round for ever. Only soon after, and only in the mode
   * it's known to have been in, since nobody is there to watch it. Otherwise the user hears and decides. A request
   * nobody can answer now gets the same record even with no turn on file, or the Quest would go on showing as waiting.
   */
  function reviveCutOff(node: string, socket: WebSocket, id: string, stranded: boolean): void {
    const quest = store.getSession(id);
    const turn = store.cutOffTurn(id);
    if (!quest || (!turn && !stranded)) return;
    const resuming =
      turn !== undefined &&
      store.sessionMode(id) !== undefined &&
      Date.now() - turn.lastActivity < REVIVE_WINDOW_MS &&
      !turn.prompt.startsWith(REVIVE_TEXT);
    const ended: Envelope = {
      node,
      session: id,
      seq: store.nextSeq(id),
      ts: Date.now(),
      type: 'session.ended',
      payload: { exitCode: null, signal: null, reason: 'restart', resuming },
    };
    store.appendEvent(ended);
    broadcast(ended);
    const attention = attentionFor(ended);
    if (attention) {
      for (const client of clients) sendToClient(client, attention);
      push?.pusher.notify(attention).catch((error: unknown) => app.log.warn({ error }, 'Web Push failed'));
    }
    if (!resuming) return;
    const send: NodeCommand = { type: 'session.send', session: id, text: REVIVE_TEXT, resume: resumeOf(quest) };
    sendJson(socket, send);
  }

  /** Sends every client a Kingdom's Patrols, and whether it takes changes from the app right now. */
  function sendPatrols(node: string): void {
    const patrols = store.patrols(node);
    const editable = patrolEditNodes.has(node);
    for (const client of clients) sendToClient(client, { kind: 'patrols', node, editable, patrols });
  }

  /** Sends every client a Kingdom's Errands as they now stand. */
  function sendErrands(node: string): void {
    const frame = { kind: 'errands', node, errands: store.errands(node) } as const;
    for (const client of clients) sendToClient(client, frame);
  }

  /** Sends every client the rows of a Kingdom's feed that were added or changed, or (`cleared`) that it's gone. */
  function sendDeeds(node: string, deeds: Deed[], cleared = false): void {
    const frame = { kind: 'deeds', node, deeds, ...(cleared ? { cleared } : {}) } as const;
    for (const client of clients) sendToClient(client, frame);
  }

  /** Sends every client a Kingdom's Scouts, with their counts as they now stand. */
  function sendScouts(node: string): void {
    const scouts = store.scouts(node, Date.now());
    for (const client of clients) sendToClient(client, { kind: 'scouts', node, scouts });
  }

  /** Tells whoever should hear that a Cast ended, once. A cancel was someone's own doing, so it says nothing. */
  function castEnded(node: string, cast: Cast): void {
    if (store.castDelivered(cast.id)) return;
    const quest = store.getSession(cast.session);
    if (cast.state === 'cancelled') {
      store.markCastDelivered(cast.id);
    } else if (cast.onFinish === 'wake' && quest && quest.status !== 'closed') {
      const waiting = wakes.get(cast.session);
      if (waiting) {
        waiting.casts.set(cast.id, cast);
        return;
      }
      const wake = guarded('waking a Quest', () => {
        const due = wakes.get(cast.session);
        wakes.delete(cast.session);
        if (due) wakeQuest(node, cast.session, [...due.casts.values()]);
      });
      const timer = setTimeout(wake, wakeDelayMs);
      timer.unref();
      wakes.set(cast.session, { casts: new Map([[cast.id, cast]]), timer });
    } else {
      store.markCastDelivered(cast.id);
      notifyCast(node, cast);
    }
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
    replayBacklog.set(socket, socket.bufferedAmount);
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
    const rebuilds =
      command.type === 'session.send' || command.type === 'session.mode' || command.type === 'session.effort';
    if (rebuilds && session.status === 'closed') {
      // A node that restarted since would rebuild it from `resume`, and a turn would run behind a closed status.
      sendToClient(clientSocket, { kind: 'error', message: `session is closed: ${command.session}` });
      return;
    }
    if (rebuilds || command.type === 'session.close') {
      // Always the store's values, so a client can't point a node at another directory.
      if (command.type === 'session.close') {
        // Record Deeds only where the Kingdom offers it and a turn finished since the last call at Close.
        const deeds =
          command.deeds === true && deedsNodes.has(session.node) && store.finishedTurnSinceClosing(command.session);
        const { deeds: _asked, ...close } = command;
        routeToNode(clientSocket, session.node, {
          ...close,
          ...(deeds ? { deeds: true } : {}),
          resume: resumeOf(session),
        });
        return;
      }
      routeToNode(clientSocket, session.node, { ...command, resume: resumeOf(session) });
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
    // The frame's opaque origin makes its module scripts cross-origin loads, which need CORS. The app's built code is
    // public anyway (it's this repository), and no answer here carries cookies or data.
    app.addHook('onRequest', async (request, reply) => {
      if (request.url.startsWith('/assets/')) void reply.header('access-control-allow-origin', '*');
    });
    // At the path the app frames, and at the path Vite builds it to, so neither runs Mermaid on the app's origin.
    const mermaidFrame = async (_request: FastifyRequest, reply: FastifyReply) => {
      const page = await readFile(path.join(webDist, 'mermaid-frame.html')).catch(() => undefined);
      if (!page) return reply.code(404).send({ error: 'no Mermaid frame in this build' });
      return reply
        .header('content-security-policy', MERMAID_FRAME_CSP)
        .header('x-content-type-options', 'nosniff')
        .type('text/html; charset=utf-8')
        .send(page);
    };
    app.get('/sandbox/mermaid-frame.html', mermaidFrame);
    app.get('/mermaid-frame.html', mermaidFrame);
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
  // What a Quest could use in a folder, before one exists. The hub only carries it: nothing is stored.
  app.get('/api/nodes/:node/inventory', async (request, reply) => {
    const { node } = request.params as { node: string };
    const { cwd } = request.query as { cwd?: string };
    const socket = nodes.get(node);
    if (!socket) return reply.code(404).send({ error: 'that Kingdom is offline' });
    if (!inventoryListers.has(node)) {
      return reply.code(409).send({ error: 'update this Kingdom first: it is too old for this' });
    }
    const requestId = randomUUID();
    const frame = HubListInventory.safeParse({ kind: 'list-inventory', requestId, ...(cwd ? { cwd } : {}) });
    if (!frame.success) return reply.code(400).send({ error: 'that folder is too long' });
    const answer = await new Promise<{ events?: NodeInventoryListed['events']; error?: string }>((resolve) => {
      const finish = (events: NodeInventoryListed['events'], error?: string) => {
        clearTimeout(timer);
        inventoryLists.delete(requestId);
        resolve({ events, error });
      };
      const timer = setTimeout(() => finish(undefined, 'the Kingdom did not answer in time'), INVENTORY_WAIT_MS);
      inventoryLists.set(requestId, { node, finish });
      sendJson(socket, frame.data);
    });
    if (!answer.events) return reply.code(409).send({ error: answer.error ?? 'the Kingdom could not list this' });
    return { events: answer.events };
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
    sendErrands(node);
    sendDeeds(node, [], true);
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
  // Done until viewed: per user, so viewing a finished Quest on one device clears it on their others at once. Any
  // Kingdom's, online or not: a Quest that finished stays finished.
  app.get('/api/unseen', async (request) => store.unseen(loginOf(request)));
  app.post('/api/sessions/:session/seen', async (request, reply) => {
    const { session } = request.params as { session: string };
    if (!z.uuid().safeParse(session).success) return reply.code(400).send({ error: 'expected a Quest id' });
    const login = loginOf(request);
    store.markSeen(login, session);
    for (const [socket, owner] of clientLogins) {
      if (owner === login) sendToClient(socket, { kind: 'seen', session });
    }
    return reply.code(204).send();
  });
  // A name set by hand (#287): every device picks it up on its next list, and the Quest's own titles no longer change it.
  app.put('/api/sessions/:session/label', async (request, reply) => {
    const { session } = request.params as { session: string };
    if (!z.uuid().safeParse(session).success) return reply.code(400).send({ error: 'expected a Quest id' });
    const label = z.object({ label: QuestTitle }).safeParse(request.body).data?.label;
    if (!label) return reply.code(400).send({ error: `a name is one line of 1 to ${MAX_QUEST_TITLE} characters` });
    if (!store.renameSession(session, label)) return reply.code(404).send({ error: 'no such Quest' });
    return reply.code(204).send();
  });
  // Only what can be answered now: a Kingdom that's removed or dead may never come back to end its Quests.
  app.get('/api/waiting', async () => store.waiting().filter(({ node }) => nodes.has(node)));
  app.get('/api/cli-latest', async () => {
    const latest = await latestCli?.();
    return latest ? { latest } : {};
  });
  // The Ship's Log. Behind the login, unlike /api/health, since it says more about the hub than a monitor needs.
  app.get('/api/hub/status', async () => {
    const latest = await latestRelease?.();
    const named = namedVersion();
    return {
      release,
      protocol: PROTOCOL_VERSION,
      uptimeMs: Math.round(process.uptime() * 1000),
      ...upkeep?.(),
      ...(latest && isOlderVersion(release, latest.version) ? { update: latest } : {}),
      ...(checkReleaseNow ? { checks: true } : {}),
      ...(releaseCheckedAt?.() !== undefined ? { checkedAt: releaseCheckedAt() } : {}),
      ...(settings ? { channel: settings.channel() } : {}),
      ...(hubUpdates ? { install: { ...(installProgress() ? { progress: installProgress() } : {}) } } : {}),
      ...(named
        ? {
            kingdomUpdates: {
              mode: settings?.kingdomUpdates().mode ?? 'auto',
              named,
              ...(named !== kingdomVersion ? { offered: kingdomVersion } : {}),
            },
          }
        : {}),
    };
  });
  // Check for updates: asks GitHub now rather than at the next period, which the checker still limits.
  app.post('/api/hub/check', async (_request, reply) => {
    if (!checkReleaseNow) return reply.code(409).send({ error: 'this hub doesn’t check for releases' });
    return { outcome: await checkReleaseNow() };
  });
  // Anyone logged in may do these: a login already has the run of every Kingdom, so there's no lesser role to protect.
  app.put('/api/hub/channel', async (request, reply) => {
    const { channel } = (request.body ?? {}) as { channel?: unknown };
    if (!settings) return reply.code(409).send({ error: 'this hub keeps no settings' });
    if (channel !== 'stable' && channel !== 'edge') {
      return reply.code(400).send({ error: 'channel must be stable or edge' });
    }
    settings.setChannel(channel);
    return reply.code(204).send();
  });
  // Install updates: the updater checks and installs the release itself, so the hub only passes on which one.
  app.post('/api/hub/update', async (request, reply) => {
    if (!hubUpdates) return reply.code(409).send({ error: 'this hub is updated from outside it' });
    const { version } = (request.body ?? {}) as { version?: unknown };
    const latest = await latestRelease?.();
    if (!latest || version !== latest.version || !isOlderVersion(release, latest.version)) {
      return reply.code(409).send({ error: 'that is not the update on offer' });
    }
    const running = installProgress();
    if (running?.state === 'installing' || running?.state === 'restarting') {
      return reply.code(409).send({ error: 'an update is already being installed' });
    }
    // Kingdoms waiting for approval move too, once the hub is up on the new release.
    if (settings && kingdomVersion && settings.kingdomUpdates().mode === 'approved') {
      settings.setKingdomApprovalAfter(latest.version);
    }
    hubUpdates.request(latest.version);
    return reply.code(202).send();
  });
  app.put('/api/hub/kingdom-updates', async (request, reply) => {
    if (!kingdomVersion || !settings) return reply.code(409).send({ error: 'this hub names no Kingdom version' });
    const { mode } = (request.body ?? {}) as { mode?: unknown };
    if (mode !== 'auto' && mode !== 'approved') return reply.code(400).send({ error: 'mode must be auto or approved' });
    // Starting approvals freezes what's named now, so turning them on moves nothing.
    settings.setKingdomUpdates(mode === 'approved' ? { mode, approved: namedVersion()! } : { mode });
    announceVersion();
    return reply.code(204).send();
  });
  app.post('/api/hub/kingdom-updates/approve', async (_request, reply) => {
    if (!kingdomVersion || !settings) return reply.code(409).send({ error: 'this hub names no Kingdom version' });
    settings.setKingdomUpdates({ mode: 'approved', approved: kingdomVersion });
    announceVersion();
    return reply.code(204).send();
  });
  // The hub's record only: it never connects to a Summon. The list of machines lasts as long as the Kingdom's connection.
  app.get('/api/nodes/:node/summons', async (request) => {
    const { node } = request.params as { node: string };
    return { summons: summons.get(node) ?? [], casts: store.casts(node, CASTS_SHOWN) };
  });
  // Scouts and their Boards (docs/SCOUTS.md). The hub keeps them for a Kingdom that's offline too.
  app.get('/api/nodes/:node/scouts', async (request) => {
    const { node } = request.params as { node: string };
    return { scouts: store.scouts(node, Date.now()) };
  });
  app.get('/api/nodes/:node/scouts/:scout', async (request, reply) => {
    const { node, scout } = request.params as { node: string; scout: string };
    return store.board(node, scout, Date.now()) ?? reply.code(404).send({ error: 'no such Scout on that Kingdom' });
  });
  app.post('/api/nodes/:node/scouts/:scout/items', async (request, reply) => {
    const { node, scout } = request.params as { node: string; scout: string };
    const change = BoardItemsChange.safeParse(request.body);
    if (!change.success) return reply.code(400).send({ error: 'expected { ids, state, until? }' });
    if (!store.hasScout(node, scout)) return reply.code(404).send({ error: 'no such Scout on that Kingdom' });
    const items = store.changeBoardItems(node, scout, change.data, Date.now());
    if (items.length > 0) {
      for (const client of clients) sendToClient(client, { kind: 'board-items', node, scout, items });
      sendScouts(node);
    }
    return { items };
  });
  app.post('/api/nodes/:node/scouts/:scout/run', async (request, reply) => {
    const { node, scout } = request.params as { node: string; scout: string };
    const socket = nodes.get(node);
    if (!socket) return reply.code(404).send({ error: 'that Kingdom is offline' });
    if (!scoutNodes.has(node))
      return reply.code(409).send({ error: 'update this Kingdom first: it is too old for this' });
    if (!store.hasScout(node, scout)) return reply.code(404).send({ error: 'no such Scout on that Kingdom' });
    sendJson(socket, { kind: 'scout-run-now', scout } satisfies HubScoutRunNow);
    return reply.code(202).send();
  });
  // Errands (docs/ERRANDS.md): the hub's own list per Kingdom, so they work while the Kingdom is offline.
  const errandsHint = `a title is one line of 1 to ${MAX_QUEST_TITLE} characters, a body is at most ${MAX_ERRAND_BODY} characters`;
  const errandId = z.uuid();
  app.get('/api/nodes/:node/errands', async (request) => {
    const { node } = request.params as { node: string };
    return { errands: store.errands(node) };
  });
  // Deeds (docs/DEEDS.md): the hub's own feed per Kingdom, read by local days the client works out.
  app.get('/api/nodes/:node/deeds', async (request, reply) => {
    const { node } = request.params as { node: string };
    const query = z
      .object({
        after: z.coerce.number().int(),
        before: z.coerce.number().int().optional(),
        project: ErrandProject.optional(),
        // A full page's `more`, sent back for the rest of the same window.
        beforeAt: z.coerce.number().int().optional(),
        beforeId: z.string().min(1).max(200).optional(),
      })
      .refine((page) => (page.beforeAt === undefined) === (page.beforeId === undefined))
      .safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({
        error:
          'after and before are epoch milliseconds; a project is one folder path; beforeAt and beforeId come together',
      });
    }
    const { after, before, project, beforeAt, beforeId } = query.data;
    return store.deedsPage(node, { after, before: before ?? Number.MAX_SAFE_INTEGER, project, beforeAt, beforeId });
  });
  app.get('/api/errands/counts', async () => store.openErrandCounts());
  app.post('/api/nodes/:node/errands', async (request, reply) => {
    const { node } = request.params as { node: string };
    const create = ErrandCreate.safeParse(request.body);
    if (!create.success) return reply.code(400).send({ error: errandsHint });
    if (!nodes.has(node) && !registry?.ids().includes(node) && !store.knowsNode(node)) {
      return reply.code(404).send({ error: 'this hub does not know that Kingdom' });
    }
    const errand = store.addErrand(node, create.data, Date.now());
    if (!errand) {
      return reply
        .code(409)
        .send({ error: `a Kingdom keeps at most ${MAX_OPEN_ERRANDS} open Errands; tick or dismiss some first` });
    }
    sendErrands(node);
    return reply.code(201).send({ errand });
  });
  app.put('/api/nodes/:node/errands/:id', async (request, reply) => {
    const { node, id } = request.params as { node: string; id: string };
    if (!errandId.safeParse(id).success) return reply.code(400).send({ error: 'not an Errand id' });
    const edit = ErrandEdit.safeParse(request.body);
    if (!edit.success) return reply.code(400).send({ error: errandsHint });
    const errand = store.editErrand(node, id, edit.data, Date.now());
    if (!errand) return reply.code(404).send({ error: 'no such Errand on that Kingdom' });
    sendErrands(node);
    return { errand };
  });
  app.put('/api/nodes/:node/errands/:id/state', async (request, reply) => {
    const { node, id } = request.params as { node: string; id: string };
    if (!errandId.safeParse(id).success) return reply.code(400).send({ error: 'not an Errand id' });
    const change = ErrandStateChange.safeParse(request.body);
    if (!change.success) return reply.code(400).send({ error: 'an Errand is open, done or dismissed' });
    const errand = store.setErrandState(node, id, change.data.state, Date.now());
    if (!errand) return reply.code(404).send({ error: 'no such Errand on that Kingdom' });
    sendErrands(node);
    return { errand };
  });
  // Patrols (docs/PATROLS.md). The hub keeps a Kingdom's list while it's offline too; changes go to the Kingdom, which
  // writes `patrol.json` and reports its list again.
  app.get('/api/nodes/:node/patrols', async (request) => {
    const { node } = request.params as { node: string };
    return { patrols: store.patrols(node), editable: patrolEditNodes.has(node) };
  });
  app.get('/api/nodes/:node/patrols/:patrol', async (request, reply) => {
    const { node, patrol } = request.params as { node: string; patrol: string };
    const runs = store.patrolRuns(node, patrol);
    const listed = store.patrols(node).find((one) => one.id === patrol);
    if (!runs || !listed) return reply.code(404).send({ error: 'no such Patrol on that Kingdom' });
    return { patrol: listed, runs };
  });
  app.post('/api/nodes/:node/patrols/:patrol/run', async (request, reply) => {
    const { node, patrol } = request.params as { node: string; patrol: string };
    const socket = nodes.get(node);
    if (!socket) return reply.code(404).send({ error: 'that Kingdom is offline' });
    if (!patrolNodes.has(node))
      return reply.code(409).send({ error: 'update this Kingdom first: it is too old for this' });
    if (!store.hasPatrol(node, patrol)) return reply.code(404).send({ error: 'no such Patrol on that Kingdom' });
    sendJson(socket, { kind: 'patrol-run-now', patrol } satisfies HubPatrolRunNow);
    return reply.code(202).send();
  });
  // Done on a Board is the hub's own mark, so it works while the Kingdom is offline.
  app.post('/api/nodes/:node/patrols/:patrol/runs/:run/done', async (request, reply) => {
    const { node, patrol, run } = request.params as { node: string; patrol: string; run: string };
    const mark = PatrolRunMark.safeParse(request.body);
    if (!mark.success) return reply.code(400).send({ error: 'expected { done: true } or { done: false }' });
    const runs = store.markPatrolRun(node, patrol, run, mark.data.done, Date.now());
    if (!runs) return reply.code(404).send({ error: 'no such run of that Patrol on that Kingdom' });
    if (runs === 'out') return reply.code(409).send({ error: 'that run is still out: mark it done once it’s back' });
    for (const client of clients) sendToClient(client, { kind: 'patrol-runs', node, patrol, runs });
    return { runs };
  });
  /** Passes a change to the Kingdom and answers with its outcome. Save and delete need a Kingdom that takes them. */
  async function changePatrol(
    node: string,
    patrol: string,
    change: PatrolChangeRequest,
    reply: import('fastify').FastifyReply,
  ) {
    const socket = nodes.get(node);
    if (!socket) return reply.code(404).send({ error: 'that Kingdom is offline' });
    if (!patrolNodes.has(node))
      return reply.code(409).send({ error: 'update this Kingdom first: it is too old for this' });
    // Deleting, pausing and resuming only ever stop a Patrol, so they work on every Kingdom; saving needs one that takes it.
    if (change.op === 'save' && !patrolEditNodes.has(node))
      return reply.code(409).send({ error: 'this Kingdom takes Patrols only from files' });
    if (change.op === 'save' && store.patrols(node).some((listed) => listed.id === patrol && listed.manifest?.script))
      return reply.code(409).send({ error: 'a script Patrol is changed only in its file on the Kingdom' });
    if (change.op !== 'save' && !store.hasPatrol(node, patrol))
      return reply.code(404).send({ error: 'no such Patrol on that Kingdom' });
    const answer = await askKingdom(socket, node, {
      kind: 'patrol-change',
      requestId: randomUUID(),
      patrol,
      change,
    });
    if (!answer.ok) return reply.code(409).send({ error: answer.reason ?? 'the Kingdom could not do this' });
    return {};
  }
  app.put('/api/nodes/:node/patrols/:patrol', async (request, reply) => {
    const { node, patrol } = request.params as { node: string; patrol: string };
    if (!PatrolId.safeParse(patrol).success) return reply.code(400).send({ error: 'not a Patrol id' });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const change = PatrolChangeRequest.safeParse({ op: 'save', manifest: body.manifest, prompt: body.prompt });
    if (!change.success) return reply.code(400).send({ error: 'expected { manifest, prompt? } as patrol.json takes' });
    return changePatrol(node, patrol, change.data, reply);
  });
  app.delete('/api/nodes/:node/patrols/:patrol', async (request, reply) => {
    const { node, patrol } = request.params as { node: string; patrol: string };
    return changePatrol(node, patrol, { op: 'delete' }, reply);
  });
  // The next run times of a schedule not yet saved, from the Kingdom, so they use its clock and time zone data.
  app.post('/api/nodes/:node/patrol-preview', async (request, reply) => {
    const { node } = request.params as { node: string };
    const wanted = PatrolPreviewRequest.safeParse(request.body);
    if (!wanted.success) {
      const issue = wanted.error.issues[0];
      return reply.code(400).send({ error: issue ? issue.message : 'expected { schedule, count? }' });
    }
    const socket = nodes.get(node);
    if (!socket) return reply.code(404).send({ error: 'that Kingdom is offline' });
    if (!patrolPreviewNodes.has(node))
      return reply.code(409).send({ error: 'update this Kingdom first: it is too old for this' });
    const answer = await askKingdom(socket, node, { kind: 'patrol-preview', requestId: randomUUID(), ...wanted.data });
    if (answer.times) return { times: answer.times };
    // The Kingdom's own reason is about the schedule; otherwise it went offline or didn't answer in time.
    return reply.code(answer.refused ? 400 : 409).send({ error: answer.reason ?? 'the Kingdom gave no times' });
  });
  for (const op of ['pause', 'resume'] as const) {
    app.post(`/api/nodes/:node/patrols/:patrol/${op}`, async (request, reply) => {
      const { node, patrol } = request.params as { node: string; patrol: string };
      return changePatrol(node, patrol, { op }, reply);
    });
  }

  /**
   * Sends a Board's request, a Patrol change, a preview or a Library request to its Kingdom and waits for its answer
   * (`scout-acted`, `patrol-changed`, `patrol-previewed` or `library-answer`), or says it didn't answer in time.
   */
  function askKingdom(
    socket: WebSocket,
    node: string,
    frame:
      | HubScoutAction
      | HubScoutQuest
      | HubPatrolChange
      | HubPatrolPreview
      | HubPatrolDraft
      | HubLibraryList
      | HubLibraryRead
      | HubLibraryWrite
      | HubLibraryBacklinks,
    waitMs = SCOUT_ACTION_WAIT_MS,
  ): Promise<KingdomAnswer> {
    return new Promise((resolve) => {
      const finish = (result: KingdomAnswer) => {
        clearTimeout(timer);
        kingdomAsks.delete(frame.requestId);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ ok: false, reason: 'the Kingdom did not answer in time' }), waitMs);
      kingdomAsks.set(frame.requestId, { node, finish });
      sendJson(socket, frame);
    });
  }

  // A Quest over Board items with the user's own prompt: the Kingdom starts it, with the items as the hub stores them.
  app.post('/api/nodes/:node/scouts/:scout/quest', async (request, reply) => {
    const { node, scout } = request.params as { node: string; scout: string };
    const wanted = BoardQuest.safeParse(request.body);
    if (!wanted.success) return reply.code(400).send({ error: 'expected { ids, prompt, project?, mode? }' });
    const socket = nodes.get(node);
    if (!socket) return reply.code(404).send({ error: 'that Kingdom is offline' });
    const now = Date.now();
    const listed = store.scouts(node, now).find((one) => one.id === scout);
    if (!listed?.manifest) return reply.code(404).send({ error: 'no such Scout on that Kingdom' });
    if (!scoutQuestNodes.has(node))
      return reply.code(409).send({ error: 'update this Kingdom first: it is too old for this' });
    const onBoard = new Map(
      (store.board(node, scout, now)?.items ?? [])
        .filter((item) => item.goneAt === undefined)
        .map((item) => [item.id, item]),
    );
    const chosen = [...new Set(wanted.data.ids)].map((id) => onBoard.get(id));
    if (chosen.some((item) => item === undefined)) {
      return reply.code(409).send({ error: 'some of these items are no longer on the Board' });
    }
    const { prompt, project, mode } = wanted.data;
    const frame: HubScoutQuest = {
      kind: 'scout-quest',
      requestId: randomUUID(),
      scout,
      items: chosen.map((item) => ScoutItem.parse(item)),
      prompt,
      ...(project ? { project } : {}),
      ...(mode ? { mode } : {}),
    };
    const answer = await askKingdom(socket, node, frame);
    if (!answer.ok) return reply.code(409).send({ error: answer.reason ?? 'the Kingdom could not do this' });
    return answer.session ? { session: answer.session } : {};
  });

  // "Patrol this": the Kingdom drafts a Patrol from an item's Quest action, with the item as the hub stores it.
  app.post('/api/nodes/:node/scouts/:scout/draft', async (request, reply) => {
    const { node, scout } = request.params as { node: string; scout: string };
    const wanted = PatrolDraftRequest.safeParse(request.body);
    if (!wanted.success) return reply.code(400).send({ error: 'expected { action, id }' });
    const socket = nodes.get(node);
    if (!socket) return reply.code(404).send({ error: 'that Kingdom is offline' });
    const now = Date.now();
    if (!store.scouts(node, now).some((one) => one.id === scout && one.manifest)) {
      return reply.code(404).send({ error: 'no such Scout on that Kingdom' });
    }
    if (!patrolDraftNodes.has(node))
      return reply.code(409).send({ error: 'update this Kingdom first: it is too old for this' });
    // A draft is only for the form, which the Kingdom would refuse to save.
    if (!patrolEditNodes.has(node))
      return reply
        .code(409)
        .send({ error: 'this Kingdom keeps its Patrols to files, so the app can’t make one there' });
    const stored = store
      .board(node, scout, now)
      ?.items.find((one) => one.id === wanted.data.id && one.goneAt === undefined);
    const item = stored === undefined ? undefined : ScoutItem.safeParse(stored);
    if (!item?.success) return reply.code(409).send({ error: 'that item is no longer on the Board' });
    const answer = await askKingdom(socket, node, {
      kind: 'patrol-draft',
      requestId: randomUUID(),
      scout,
      action: wanted.data.action,
      item: item.data,
    });
    if (answer.draft) return { draft: answer.draft };
    return reply.code(answer.refused ? 400 : 409).send({ error: answer.reason ?? 'the Kingdom gave no draft' });
  });

  // A quest or run action: the Kingdom carries it out on the items as the hub stores them, never as a client sends them.
  app.post('/api/nodes/:node/scouts/:scout/act', async (request, reply) => {
    const { node, scout } = request.params as { node: string; scout: string };
    const wanted = BoardAct.safeParse(request.body);
    if (!wanted.success) return reply.code(400).send({ error: 'expected { action, ids }' });
    const socket = nodes.get(node);
    if (!socket) return reply.code(404).send({ error: 'that Kingdom is offline' });
    const now = Date.now();
    const listed = store.scouts(node, now).find((one) => one.id === scout);
    if (!listed) return reply.code(404).send({ error: 'no such Scout on that Kingdom' });
    if (!scoutNodes.has(node))
      return reply.code(409).send({ error: 'update this Kingdom first: it is too old for this' });
    const manifest = listed.manifest;
    const { action: key, ids } = wanted.data;
    const action = manifest && Object.hasOwn(manifest.actions, key) ? manifest.actions[key] : undefined;
    if (!manifest || !action) return reply.code(400).send({ error: `the Scout declares no action ${key}` });
    if (action.kind !== 'quest' && action.kind !== 'run') {
      return reply.code(400).send({ error: `the Board changes an item's state itself for ${action.label}` });
    }
    const unique = [...new Set(ids)];
    const single = action.kind === 'quest' || !action.batch;
    if (single && unique.length !== 1)
      return reply.code(400).send({ error: `${action.label} takes one item at a time` });
    const onBoard = new Map(
      (store.board(node, scout, now)?.items ?? [])
        .filter((item) => item.goneAt === undefined)
        .map((item) => [item.id, item]),
    );
    const chosen = unique.map((id) => onBoard.get(id));
    if (chosen.some((item) => item === undefined)) {
      return reply.code(409).send({ error: 'some of these items are no longer on the Board' });
    }
    const items = chosen.map((item) => ScoutItem.parse(item));
    if (!items.every((item) => (item.actions ?? manifest.defaults ?? []).includes(key))) {
      return reply.code(400).send({ error: `not every item offers ${action.label}` });
    }
    const requestId = randomUUID();
    const frame: HubScoutAction = { kind: 'scout-action', requestId, scout, action: key, items };
    const answer = await askKingdom(socket, node, frame);
    if (!answer.ok) return reply.code(409).send({ error: answer.reason ?? 'the Kingdom could not do this' });
    if (action.kind === 'run' && action.then) {
      const state = action.then === 'done' ? 'done' : 'dismissed';
      const changed = store.changeBoardItems(node, scout, { ids: unique, state }, Date.now());
      if (changed.length > 0) {
        for (const client of clients) sendToClient(client, { kind: 'board-items', node, scout, items: changed });
        sendScouts(node);
      }
    }
    return answer.session ? { session: answer.session } : {};
  });
  // The Library: the hub carries each request to the Kingdom and its answer back, and keeps nothing (docs/LIBRARY.md).
  /**
   * Waits for one of a Kingdom's image slots: true once it holds one, false if none came free within the Library's wait.
   * The holder hands it back with `freeImageSlot`.
   */
  function takeImageSlot(node: string): Promise<boolean> {
    let slots = libraryImageSlots.get(node);
    if (!slots) libraryImageSlots.set(node, (slots = { busy: 0, waiting: [] }));
    if (slots.busy < LIBRARY_IMAGE_SLOTS) {
      slots.busy += 1;
      return Promise.resolve(true);
    }
    const queue = slots.waiting;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        queue.splice(queue.indexOf(given), 1);
        resolve(false);
      }, LIBRARY_WAIT_MS);
      const given = () => {
        clearTimeout(timer);
        resolve(true);
      };
      queue.push(given);
    });
  }
  /** Hands a slot to the longest waiter, or frees it. */
  function freeImageSlot(node: string): void {
    const slots = libraryImageSlots.get(node);
    if (!slots) return;
    const next = slots.waiting.shift();
    if (next) return next(true);
    slots.busy -= 1;
    if (slots.busy === 0) libraryImageSlots.delete(node);
  }
  /**
   * Asks a Kingdom with a Library, and sends its answer, or why there is none, with the Library's headers. `answered`
   * sends a successful answer (by default the answer's fields as JSON); `image` takes one of the Kingdom's image slots.
   */
  async function askLibrary(
    node: string,
    reply: FastifyReply,
    frame: HubLibraryList | HubLibraryRead | HubLibraryWrite | HubLibraryBacklinks,
    { image = false, answered }: { image?: boolean; answered?: (library: NodeLibraryAnswer) => unknown } = {},
  ) {
    libraryHeaders(reply);
    if (!nodes.has(node)) return reply.code(404).send({ error: 'that Kingdom is offline' });
    if (!libraryNodes.has(node))
      return reply.code(409).send({ error: 'update this Kingdom first: it is too old for this' });
    if (image && !(await takeImageSlot(node))) return reply.code(409).send({ error: 'the Kingdom is busy' });
    let answer: KingdomAnswer;
    try {
      // Looked up again: the Kingdom may have gone, or come back on another socket, while this waited for a slot.
      const socket = nodes.get(node);
      if (!socket) return reply.code(404).send({ error: 'that Kingdom is offline' });
      answer = await askKingdom(socket, node, frame, LIBRARY_WAIT_MS);
    } finally {
      if (image) freeImageSlot(node);
    }
    const library = answer.library;
    if (!library?.ok) {
      const reason = library?.reason ?? answer.reason ?? 'the Kingdom could not do this';
      return reply
        .code(library ? libraryRefusalStatus(library.reason) : 409)
        .send({ error: reason, ...(library?.version ? { version: library.version } : {}) });
    }
    if (answered) return answered(library);
    const { kind: _kind, requestId: _requestId, ok: _ok, reason: _reason, ...result } = library;
    return result;
  }
  const libraryPathOf = (request: FastifyRequest) => LibraryPath.safeParse((request.query as { path?: unknown }).path);
  app.get('/api/nodes/:node/library', async (request, reply) => {
    const { node } = request.params as { node: string };
    return askLibrary(node, reply, { kind: 'library-list', requestId: randomUUID() });
  });
  // Text only: images come through their own route, with their own content type.
  app.get('/api/nodes/:node/library/tome', async (request, reply) => {
    const { node } = request.params as { node: string };
    const wanted = libraryPathOf(request);
    if (!wanted.success) return libraryHeaders(reply).code(400).send({ error: 'expected ?path= inside the Library' });
    return askLibrary(node, reply, { kind: 'library-read', requestId: randomUUID(), path: wanted.data });
  });
  // An image's bytes, for the reader's <img>: typed by the hub from the extension, at most two in flight per Kingdom.
  app.get('/api/nodes/:node/library/file', async (request, reply) => {
    const { node } = request.params as { node: string };
    const wanted = libraryPathOf(request);
    if (!wanted.success) return libraryHeaders(reply).code(400).send({ error: 'expected ?path= inside the Library' });
    const extension = libraryExtension(wanted.data);
    const type = Object.hasOwn(LIBRARY_IMAGE_TYPES, extension) ? LIBRARY_IMAGE_TYPES[extension] : undefined;
    if (!type) return libraryHeaders(reply).code(404).send({ error: 'not an image the Library shows' });
    const frame: HubLibraryRead = { kind: 'library-read', requestId: randomUUID(), path: wanted.data, as: 'image' };
    return askLibrary(node, reply, frame, {
      image: true,
      answered: ({ tome }) => {
        if (tome?.kind !== 'image') return reply.code(409).send({ error: 'not an image' });
        const bytes = Buffer.from(tome.content, tome.encoding === 'base64' ? 'base64' : 'utf8');
        if (bytes.length > MAX_IMAGE_BYTES) return reply.code(413).send({ error: 'too large' });
        if (type === 'image/svg+xml') libraryHeaders(reply, LIBRARY_SVG_CSP);
        return reply.header('cache-control', 'no-store').type(type).send(bytes);
      },
    });
  });
  // An HTML Tome: into the app's sandboxed frame, or as a download, so it never poses as a page at the hub's address.
  app.get('/api/nodes/:node/library/page', async (request, reply) => {
    const { node } = request.params as { node: string };
    const wanted = libraryPathOf(request);
    if (!wanted.success) return libraryHeaders(reply).code(400).send({ error: 'expected ?path= inside the Library' });
    if (!LIBRARY_PAGE_EXTENSIONS.has(libraryExtension(wanted.data)))
      return libraryHeaders(reply).code(404).send({ error: 'not an HTML Tome' });
    const framed = forTheAppsFrame(request.headers);
    return askLibrary(
      node,
      reply,
      { kind: 'library-read', requestId: randomUUID(), path: wanted.data },
      {
        answered: ({ tome }) => {
          if (tome?.kind !== 'html') return reply.code(409).send({ error: 'not an HTML Tome' });
          const bytes = Buffer.from(tome.content, tome.encoding === 'base64' ? 'base64' : 'utf8');
          reply.header('cache-control', 'no-store');
          if (framed) return libraryHeaders(reply, libraryPageCsp).type('text/html; charset=utf-8').send(bytes);
          const name = wanted.data.slice(wanted.data.lastIndexOf('/') + 1).replace(/[^A-Za-z0-9._-]/g, '_');
          return reply
            .header('content-disposition', `attachment; filename="${name}"`)
            .type('application/octet-stream')
            .send(bytes);
        },
      },
    );
  });
  app.put('/api/nodes/:node/library/tome', { bodyLimit: LIBRARY_BODY_LIMIT }, async (request, reply) => {
    const { node } = request.params as { node: string };
    const wanted = TomeWrite.safeParse(request.body);
    if (!wanted.success) {
      const issue = wanted.error.issues.find((one) => one.path[0] === 'content');
      return libraryHeaders(reply)
        .code(400)
        .send({ error: issue ? issue.message : 'expected { path, content, base } with base a version or null' });
    }
    return askLibrary(node, reply, { kind: 'library-write', requestId: randomUUID(), ...wanted.data });
  });
  app.get('/api/nodes/:node/library/backlinks', async (request, reply) => {
    const { node } = request.params as { node: string };
    const wanted = libraryPathOf(request);
    if (!wanted.success) return libraryHeaders(reply).code(400).send({ error: 'expected ?path= inside the Library' });
    return askLibrary(node, reply, { kind: 'library-backlinks', requestId: randomUUID(), path: wanted.data });
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
          ...(deedsNodes.has(node) ? { deeds: true } : {}),
          ...(libraryNodes.has(node) ? { library: libraryNodes.get(node) } : {}),
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
      // A second Crystal on a node id: nothing it sends counts, and it's closed once its hold is up.
      let held = false;

      keepBeating(socket, nodeHeartbeatMs, () =>
        app.log.warn({ node: helloNode }, 'a Kingdom stopped answering, dropping it'),
      );

      const heard = (): void => void lastHeard.set(socket, Date.now());
      heard();
      socket.on('pong', heard);
      socket.on('message', heard);

      // A token can go while its link is up: rotated by hand, by a script or from a shell, out of the hub's sight.
      socket.on(
        'pong',
        guarded('checking a node token', () => {
          if (!registry || registry.verify(bearer(request.headers.authorization)) === tokenNode) return;
          app.log.warn({ node: tokenNode }, 'closed a link whose node token no longer works');
          socket.close(CLOSE_TOKEN_REVOKED, 'node token revoked');
        }),
      );

      const handleFrame = guarded('handling a frame from a node', (data: RawData): void => {
        if (held) return;
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
            // Told first: updating is how a Kingdom that updates itself gets past this refusal.
            if (hello.data.selfUpdate) nameVersion(socket);
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
          const existing = nodes.get(hello.data.node);
          // A live Crystal answers every beat, so one heard this recently isn't the leftover of a dead link: this is a
          // cloned machine or a forgotten service, and its list of sessions says nothing about the first's Quests.
          if (existing && stillAnswering(existing)) {
            held = true;
            app.log.error(
              { node: hello.data.node, release: hello.data.release },
              'two Crystals are using this node id: keeping the one that is connected and turning the other away. ' +
                'Stop the extra service, or give that machine its own node id and token',
            );
            const hold = setTimeout(
              () => socket.close(CLOSE_DUPLICATE_NODE, 'another Crystal is connected as this node'),
              duplicateHoldMs,
            );
            hold.unref();
            socket.on('close', () => clearTimeout(hold));
            return;
          }
          helloNode = hello.data.node;
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
          if (hello.data.inventory) inventoryListers.add(helloNode);
          else inventoryListers.delete(helloNode);
          if (hello.data.scouts) scoutNodes.add(helloNode);
          else scoutNodes.delete(helloNode);
          if (hello.data.scoutQuests) scoutQuestNodes.add(helloNode);
          else scoutQuestNodes.delete(helloNode);
          if (hello.data.patrolDrafts) patrolDraftNodes.add(helloNode);
          else patrolDraftNodes.delete(helloNode);
          if (hello.data.deeds) deedsNodes.add(helloNode);
          else deedsNodes.delete(helloNode);
          if (hello.data.library) libraryNodes.set(helloNode, hello.data.library);
          else libraryNodes.delete(helloNode);
          if (hello.data.patrols) patrolNodes.add(helloNode);
          else patrolNodes.delete(helloNode);
          if (hello.data.patrols && hello.data.patrolsFromApp) patrolEditNodes.add(helloNode);
          else patrolEditNodes.delete(helloNode);
          if (hello.data.patrols && hello.data.patrolPreview) patrolPreviewNodes.add(helloNode);
          else patrolPreviewNodes.delete(helloNode);
          selfUpdates.delete(helloNode);
          selfUpdaters.delete(helloNode);
          if (hello.data.selfUpdate) {
            selfUpdaters.add(helloNode);
            nameVersion(socket);
          }
          // A node that lists what it holds lets us release sessions whose process died with it.
          if (hello.data.sessions) {
            const node = helloNode;
            const released = store.releaseOrphans(node, hello.data.sessions);
            if (released.length > 0) app.log.info({ node, released }, 'marked orphaned sessions idle');
            // Also what an earlier hub left waiting: those aren't running, so nothing above released them.
            // One scan of the whole history, since a Kingdom can hold many Quests.
            const waiting = store.waiting();
            const stranded = new Set(waiting.map((entry) => entry.session));
            const unheld = waiting
              .filter((entry) => entry.node === node && !hello.data.sessions?.includes(entry.session))
              .map((entry) => entry.session);
            for (const id of new Set([...released, ...unheld])) {
              guarded('recording a cut-off Quest', reviveCutOff)(node, socket, id, stranded.has(id));
            }
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

        const inventoryListed = NodeInventoryListed.safeParse(parsed);
        if (inventoryListed.success) {
          const waiting = inventoryLists.get(inventoryListed.data.requestId);
          if (waiting?.node !== helloNode) {
            app.log.warn({ node: helloNode }, 'dropped an Inventory list nobody is waiting for from this node');
            return;
          }
          waiting.finish(inventoryListed.data.events);
          return;
        }

        const acted = NodeScoutActed.safeParse(parsed);
        if (acted.success) {
          const waiting = kingdomAsks.get(acted.data.requestId);
          if (waiting?.node !== helloNode) {
            app.log.warn({ node: helloNode }, 'dropped a Board action answer nobody is waiting for from this node');
            return;
          }
          const { ok, reason, session } = acted.data;
          waiting.finish({ ok, ...(reason ? { reason } : {}), ...(session ? { session } : {}) });
          return;
        }

        const patrolChanged = NodePatrolChanged.safeParse(parsed);
        if (patrolChanged.success) {
          const waiting = kingdomAsks.get(patrolChanged.data.requestId);
          if (waiting?.node !== helloNode) {
            app.log.warn({ node: helloNode }, 'dropped a Patrol change answer nobody is waiting for from this node');
            return;
          }
          const { ok, reason } = patrolChanged.data;
          waiting.finish({ ok, ...(reason ? { reason } : {}) });
          return;
        }

        const drafted = NodePatrolDrafted.safeParse(parsed);
        if (drafted.success) {
          const waiting = kingdomAsks.get(drafted.data.requestId);
          if (waiting?.node !== helloNode) {
            app.log.warn({ node: helloNode }, 'dropped a Patrol draft nobody is waiting for from this node');
            return;
          }
          const { draft, reason } = drafted.data;
          waiting.finish(
            draft ? { ok: true, draft } : { ok: false, refused: true, reason: reason ?? 'the Kingdom gave no draft' },
          );
          return;
        }

        // A draft answer that doesn't fit, from a Kingdom that disagrees about the schema, fails the ask now rather than
        // leaving it to time out.
        const badDraft = parsed as { kind?: unknown; requestId?: unknown };
        if (badDraft.kind === 'patrol-drafted' && typeof badDraft.requestId === 'string') {
          const waiting = kingdomAsks.get(badDraft.requestId);
          if (waiting?.node === helloNode)
            waiting.finish({ ok: false, reason: 'the Kingdom’s draft doesn’t fit a Patrol' });
          return;
        }

        const previewed = NodePatrolPreviewed.safeParse(parsed);
        if (previewed.success) {
          const waiting = kingdomAsks.get(previewed.data.requestId);
          if (waiting?.node !== helloNode) {
            app.log.warn({ node: helloNode }, 'dropped a Patrol preview nobody is waiting for from this node');
            return;
          }
          const { times, reason } = previewed.data;
          waiting.finish(
            times ? { ok: true, times } : { ok: false, refused: true, reason: reason ?? 'the Kingdom gave no times' },
          );
          return;
        }

        const libraryChanged = NodeLibraryChanged.safeParse(parsed);
        if (libraryChanged.success) {
          const { paths, all } = libraryChanged.data;
          const frame: HubToClient = {
            kind: 'library-changed',
            node: helloNode,
            ...(paths ? { paths } : {}),
            ...(all ? { all } : {}),
          };
          for (const watcher of libraryWatchers.get(helloNode) ?? []) sendToClient(watcher, frame);
          return;
        }

        const libraryAnswer = NodeLibraryAnswer.safeParse(parsed);
        if (libraryAnswer.success) {
          const waiting = kingdomAsks.get(libraryAnswer.data.requestId);
          if (waiting?.node !== helloNode) {
            app.log.warn({ node: helloNode }, 'dropped a Library answer nobody is waiting for from this node');
            return;
          }
          waiting.finish({ ok: libraryAnswer.data.ok, library: libraryAnswer.data });
          return;
        }

        const patrolList = NodePatrols.safeParse(parsed);
        if (patrolList.success) {
          store.putPatrols(helloNode, patrolList.data.patrols);
          sendPatrols(helloNode);
          return;
        }

        const patrolRun = NodePatrolRun.safeParse(parsed);
        if (patrolRun.success) {
          const { patrol, run } = patrolRun.data;
          if (!store.hasPatrol(helloNode, patrol)) {
            app.log.warn({ node: helloNode, patrol }, 'dropped a run of a Patrol this node does not list');
            return;
          }
          const runs = store.recordPatrolRun(helloNode, patrol, run);
          for (const client of clients) sendToClient(client, { kind: 'patrol-runs', node: helloNode, patrol, runs });
          sendPatrols(helloNode);
          if (run.session === undefined && (run.outcome === 'finished' || run.outcome === 'failed')) {
            const row = store.deed(helloNode, `run:${run.id}`);
            if (row) sendDeeds(helloNode, [row]);
          }
          return;
        }

        const summonList = NodeSummons.safeParse(parsed);
        if (summonList.success) {
          summons.set(helloNode, summonList.data.summons);
          return;
        }

        const scoutList = NodeScouts.safeParse(parsed);
        if (scoutList.success) {
          store.putScouts(helloNode, scoutList.data.scouts);
          sendScouts(helloNode);
          return;
        }

        const scoutRun = NodeScoutRun.safeParse(parsed);
        if (scoutRun.success) {
          const { scout, run, items } = scoutRun.data;
          if (!store.hasScout(helloNode, scout)) {
            app.log.warn({ node: helloNode, scout }, 'dropped a run of a Scout this node does not list');
            return;
          }
          const board = store.recordScoutRun(helloNode, scout, run, items, Date.now());
          if (board) {
            for (const client of clients) sendToClient(client, { kind: 'board', node: helloNode, board });
            sendScouts(helloNode);
          }
          return;
        }

        const reported = NodeCast.safeParse(parsed);
        if (reported.success) {
          const { cast } = reported.data;
          if (store.getSession(cast.session)?.node !== helloNode) {
            app.log.warn({ node: helloNode, session: cast.session }, 'dropped a Cast for another node-s session');
            return;
          }
          // A report that changes nothing can still be an end nobody heard about, so it carries on from here.
          const stored = store.upsertCast(helloNode, cast);
          if (stored) for (const client of clients) sendToClient(client, { kind: 'cast', node: helloNode, cast });
          if (cast.state !== 'running') castEnded(helloNode, cast);
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
          const { session, message } = nodeError.data;
          // None on record yet is fine: a tab can be waiting on a Quest the Kingdom refused to start.
          const owner = session === undefined ? undefined : store.getSession(session)?.node;
          if (owner !== undefined && owner !== helloNode) {
            app.log.warn({ node: helloNode, owner, session }, 'dropped a node-error about another node-s session');
            return;
          }
          app.log.warn({ node: helloNode, session }, message);
          broadcastError(session, message);
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
        try {
          inserted = store.appendEvent(envelope.data);
        } catch (error) {
          if (!(error instanceof BadEvent)) {
            // No ack: the Kingdom keeps it and sends it again when it next connects.
            app.log.error({ err: error, session, seq, type }, 'could not store an event, leaving it unacked');
            return;
          }
          // It will never succeed, so ack it anyway; otherwise the node resends it on every connect.
          app.log.error({ err: error, session, seq, type }, 'failed to append event with a bad payload');
          sendJson(socket, { kind: 'ack', session, seq } satisfies HubAck);
          broadcastError(session, `dropped a ${type} event (seq ${seq}) with a bad payload`);
          return;
        }

        sendJson(socket, { kind: 'ack', session, seq } satisfies HubAck);

        if (inserted) {
          broadcast(envelope.data);
          if (envelope.data.type === 'errand.left') sendErrands(helloNode);
          const deedId = deedIdFor(envelope.data);
          const deedRow = deedId ? store.deed(helloNode, deedId) : undefined;
          if (deedRow) sendDeeds(helloNode, [deedRow]);
          const attention = attentionFor(envelope.data);
          if (attention) {
            for (const client of clients) sendToClient(client, attention);
            push?.pusher.notify(attention).catch((error: unknown) => app.log.warn({ error }, 'Web Push failed'));
          }
        }
      });
      socket.on('message', handleFrame);

      socket.on('close', () => {
        if (helloNode !== null && nodes.get(helloNode) === socket) {
          nodes.delete(helloNode);
          // What it reported is stale now: Recruit and New Quest mustn't offer an offline node's lists.
          external.delete(helloNode);
          projects.delete(helloNode);
          summons.delete(helloNode);
          releases.delete(helloNode);
          cliVersions.delete(helloNode);
          cliUpdaters.delete(helloNode);
          selfUpdates.delete(helloNode);
          selfUpdaters.delete(helloNode);
          cliUpdates.get(helloNode)?.finish({ error: 'the Kingdom went offline during the update' });
          inventoryListers.delete(helloNode);
          scoutNodes.delete(helloNode);
          scoutQuestNodes.delete(helloNode);
          patrolDraftNodes.delete(helloNode);
          deedsNodes.delete(helloNode);
          libraryNodes.delete(helloNode);
          patrolNodes.delete(helloNode);
          patrolEditNodes.delete(helloNode);
          patrolPreviewNodes.delete(helloNode);
          for (const waiting of [...inventoryLists.values()]) {
            if (waiting.node === helloNode) waiting.finish(undefined, 'the Kingdom went offline');
          }
          for (const waiting of [...kingdomAsks.values()]) {
            if (waiting.node === helloNode) waiting.finish({ ok: false, reason: 'the Kingdom went offline' });
          }
        }
      });
    },
  );

  app.get('/client', { websocket: true }, (socket, request) => {
    const login = loginOf(request);
    clients.add(socket);
    clientLogins.set(socket, login);

    keepBeating(socket, clientHeartbeatMs, () => app.log.info({ login }, 'a tab stopped answering, dropping it'));
    // The login was checked at the upgrade, and can go while the tab stays open: a token removed from a shell, say.
    socket.on(
      'pong',
      guarded('checking a login', () => {
        if (!auth || auth.identify(request) === login) return;
        app.log.warn({ login }, 'closed a tab whose login is no longer allowed');
        socket.close(CLOSE_LOGIN_REVOKED, 'login removed');
      }),
    );

    socket.on(
      'message',
      guarded('handling a frame from a client', (data: RawData) => {
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

        if (message.data.kind === 'ping') {
          if (socket.readyState === socket.OPEN) socket.send(PONG_FRAME);
        } else if (message.data.kind === 'subscribe') {
          handleSubscribe(socket, message.data.session, message.data.fromSeq);
        } else if (message.data.kind === 'command') {
          handleCommand(socket, message.data.command);
        } else if (message.data.kind === 'library-watch') {
          const { node, open } = message.data;
          if (node.length === 0 || node.length > MAX_NODE_ID) return;
          if (open) {
            let watching = libraryWatchers.get(node);
            if (!watching) libraryWatchers.set(node, (watching = new Set()));
            watching.add(socket);
          } else {
            const watching = libraryWatchers.get(node);
            watching?.delete(socket);
            if (watching?.size === 0) libraryWatchers.delete(node);
          }
        }
      }),
    );

    socket.on('close', () => {
      clients.delete(socket);
      clientLogins.delete(socket);
      for (const [node, watching] of libraryWatchers) {
        watching.delete(socket);
        if (watching.size === 0) libraryWatchers.delete(node);
      }
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
