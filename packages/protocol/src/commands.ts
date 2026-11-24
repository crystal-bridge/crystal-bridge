import { z } from 'zod';
import { Appearance } from './appearance.js';
import { Envelope } from './envelope.js';
import { DeedsFrame } from './deeds.js';
import { ErrandsFrame } from './errands.js';
import { LibraryChangedFrame, LibraryInfo } from './library.js';
import { Effort, Engine, PermissionMode } from './mode.js';
import { PatrolRunsFrame, PatrolsFrame } from './patrols.js';
import { BoardFrame, BoardItemsFrame, ScoutsFrame } from './scouts.js';

export { Effort, Engine, PermissionMode } from './mode.js';

/** How many files one prompt or follow-up can carry, and each one's size as base64 (about 5 MB of file). */
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BASE64 = 7_000_000;

/**
 * A file sent with a prompt (#14): the node saves it outside the project and adds its path to the prompt, so the agent
 * opens it with its own tools (images included). Never stored by the hub; only the prompt text is.
 */
export const Attachment = z.object({
  name: z.string().min(1).max(200),
  type: z.string().max(100),
  data: z
    .string()
    .max(MAX_ATTACHMENT_BASE64)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
});
export type Attachment = z.infer<typeof Attachment>;
const Attachments = z.array(Attachment).max(MAX_ATTACHMENTS);

/**
 * Filled in by the hub from its store, never by clients: lets a node that restarted and no longer holds a session
 * rebuild it, on the same engine, numbering its events after the ones the hub already has.
 */
export const Resume = z.object({
  cwd: z.string(),
  nextSeq: z.number().int().nonnegative(),
  /** The engine the session started on; unset is `stream`. */
  engine: Engine.optional(),
  /** The effort the session started with; unset is the CLI's default. */
  effort: Effort.optional(),
  /** The mode the session was last in; unset is a session from before it was recorded, on the node's default. */
  mode: PermissionMode.optional(),
});
export type Resume = z.infer<typeof Resume>;

// client -> hub -> node
export const NodeCommand = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session.start'),
    node: z.string(),
    session: z.uuid(),
    cwd: z.string(),
    prompt: z.string().min(1),
    /** Unset: the node's default (CRYSTAL_DEFAULT_MODE). */
    mode: PermissionMode.optional(),
    /** Run in a new git worktree of `cwd`'s repository, on its own branch, so sessions don't collide. */
    worktree: z.boolean().optional(),
    /**
     * Start as a fork of this session: a copy of its conversation so far that continues separately. Same node, and
     * the same `cwd` as the source, since the engine finds a conversation by its folder; so never with `worktree`.
     */
    forkFrom: z.uuid().optional(),
    /** Unset: `stream`. A node runs only the engines its hello lists. */
    engine: Engine.optional(),
    /** Passed as `--effort` to every process this session starts; unset leaves the CLI's default. */
    effort: Effort.optional(),
    /** Files sent with the opening prompt. */
    attachments: Attachments.optional(),
  }),
  z.object({
    /** Closes a session for good: its process stops, its history stays, and it takes no more follow-ups. */
    type: z.literal('session.close'),
    session: z.uuid(),
    /** Also remove the session's worktree, if it has one and nothing in it is uncommitted. */
    removeWorktree: z.boolean().optional(),
    /** Filled in by the hub, as for session.send, so a node that no longer holds the session can still close it. */
    resume: Resume.optional(),
    /**
     * Record its Deeds: after closing, the Kingdom asks for the Quest's Deeds from a digest of it (docs/DEEDS.md). The
     * hub passes it on only to a Kingdom whose hello offers `deeds`, and only when the Quest has a finished turn since
     * its last Deeds at Close.
     */
    deeds: z.boolean().optional(),
  }),
  z.object({
    /** Switches a session's permission mode; a running process changes at once, otherwise on its next start. */
    type: z.literal('session.mode'),
    session: z.uuid(),
    mode: PermissionMode,
    /** Filled in by the hub from its store, never by clients; see `Resume`. */
    resume: Resume.optional(),
  }),
  z.object({
    type: z.literal('session.send'),
    session: z.uuid(),
    text: z.string().min(1),
    /** Files sent with the follow-up. */
    attachments: Attachments.optional(),
    /** Filled in by the hub from its store, never by clients; see `Resume`. */
    resume: Resume.optional(),
  }),
  z.object({
    /** Take over a session the node found outside the bridge: replay its history, resume it on the next send. */
    type: z.literal('session.adopt'),
    node: z.string(),
    session: z.uuid(),
    /** The engine its follow-ups resume on; unset is `stream`. A node adopts only on engines its hello lists. */
    engine: Engine.optional(),
  }),
  z.object({
    type: z.literal('session.interrupt'),
    session: z.uuid(),
  }),
  z.object({
    /**
     * Sets a session's effort, or back to the CLI's default with none. Nothing running is touched: the next message
     * moves to a new process with it, if that's safe, and the conversation carries on there.
     */
    type: z.literal('session.effort'),
    session: z.uuid(),
    effort: Effort.optional(),
    /** Filled in by the hub from its store, never by clients; see `Resume`. */
    resume: Resume.optional(),
  }),
  z.object({
    /**
     * Keystrokes for a terminal that's asking something (`terminal.screen`), or `retype` to type the held message
     * again. Refused unless it's asking, so it stays an answer to a dialog and not a way to drive a Quest. It gives the
     * same control as a prompt, so the same login and scopes apply.
     */
    type: z.literal('session.keys'),
    session: z.uuid(),
    keys: z.string().min(1).max(256).optional(),
    retype: z.boolean().optional(),
  }),
  z.object({
    /**
     * Reads one file inside a session's folder for the read-only viewer; the node answers with a `file` frame the hub
     * relays to the requesting client only. Relative paths resolve against the session's folder.
     */
    type: z.literal('file.read'),
    session: z.uuid(),
    requestId: z.uuid(),
    path: z.string().min(1).max(4096),
    /** Filled in by the hub from its store, never by clients: the session's folder, for a node that restarted since. */
    cwd: z.string().optional(),
  }),
  z.object({
    type: z.literal('permission.answer'),
    session: z.uuid(),
    requestId: z.string(),
    behavior: z.enum(['allow', 'deny']),
    message: z.string().optional(),
    /** Answers to an AskUserQuestion request, keyed by question text; sent with `allow`. */
    answers: z.record(z.string(), z.string()).optional(),
  }),
]);
export type NodeCommand = z.infer<typeof NodeCommand>;

/** How a Cast (a job on a Summon, docs/SUMMONS.md) stands. Every state but `running` is final. */
export const CastState = z.enum(['running', 'succeeded', 'failed', 'cancelled', 'lost']);
export type CastState = z.infer<typeof CastState>;

/** What happens when a Cast ends: `notify` tells the user, `wake` sends the Quest a message, which costs a turn. */
export const CastFinish = z.enum(['notify', 'wake']);
export type CastFinish = z.infer<typeof CastFinish>;

/** The longest command and log end a Cast carries to the hub, in characters. The full log stays on the target. */
export const MAX_CAST_COMMAND = 4000;
export const MAX_CAST_TAIL = 8000;

export const CastProgress = z.object({
  done: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  label: z.string().max(200).optional(),
});
export type CastProgress = z.infer<typeof CastProgress>;

/** One job, as the hub stores and shows it. */
export const Cast = z.object({
  id: z.uuid(),
  /** The Quest that started it. */
  session: z.uuid(),
  /** The Summon's name, never its address. */
  summon: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  command: z.string().max(MAX_CAST_COMMAND),
  cwd: z.string().max(4096).optional(),
  onFinish: CastFinish,
  state: CastState,
  exitCode: z.number().int().optional(),
  startedAt: z.number().int(),
  finishedAt: z.number().int().optional(),
  /** Running, but waiting for its turn on the Summon. */
  queued: z.boolean().optional(),
  /** How far it's got, from a `::summon progress` line its script printed. */
  progress: CastProgress.optional(),
  /** The end of the log. */
  logTail: z.string().max(MAX_CAST_TAIL),
});
export type Cast = z.infer<typeof Cast>;

/** A machine a Kingdom may use. `local` is the Kingdom itself, which needs no SSH. */
export const Summon = z.object({
  name: z.string().min(1).max(200),
  local: z.boolean().optional(),
  /** How many Casts it runs at once; unset is one. */
  limit: z.number().int().positive().optional(),
});
export type Summon = z.infer<typeof Summon>;

// node -> hub control frames
/**
 * The node link's protocol version. Bump it only for a change an older peer can't handle; additive changes
 * (new optional fields, new event types old code ignores) keep it. The hub refuses a node on another version.
 */
export const PROTOCOL_VERSION = 1;

export const NodeHello = z.object({
  kind: z.literal('hello'),
  node: z.string().min(1),
  /** Unset means 1: nodes from before the field existed. */
  protocol: z.number().int().positive().optional(),
  /** Sessions the node still holds. The hub marks the node's other running sessions idle. */
  sessions: z.array(z.uuid()).optional(),
  /** Engines this node can run sessions on; unset means just `stream`. */
  engines: z.array(z.string()).optional(),
  /** The node agent's release (e.g. the deployed commit), for display. */
  release: z.string().max(64).optional(),
  /** This node can run the agent CLI's own update when asked (`HubCliUpdate`); older nodes leave it out. */
  cliUpdate: z.boolean().optional(),
  /** This node installs releases itself and wants the version to run (`HubKingdomVersion`); older nodes leave it out. */
  selfUpdate: z.boolean().optional(),
  /** This node lists what a Quest could use before one starts (`HubListInventory`); older nodes leave it out. */
  inventory: z.boolean().optional(),
  /** This node runs Scouts and takes `scout-run-now` and `scout-action` (docs/SCOUTS.md); older nodes leave it out. */
  scouts: z.boolean().optional(),
  /** This node starts a Quest from Board items with the user's prompt (`HubScoutQuest`); older nodes leave it out. */
  scoutQuests: z.boolean().optional(),
  /** This node runs Patrols and takes `patrol-run-now` and `patrol-change` (docs/PATROLS.md); older nodes leave it out. */
  patrols: z.boolean().optional(),
  /** This node takes new and changed Patrols from the app; false when its owner keeps Patrols to files. */
  patrolsFromApp: z.boolean().optional(),
  /** This node answers `patrol-preview` with a schedule's next run times; older nodes leave it out. */
  patrolPreview: z.boolean().optional(),
  /** This node answers `patrol-draft` with a Patrol drafted from a Board item ("Patrol this"); older nodes leave it out. */
  patrolDrafts: z.boolean().optional(),
  /** This node makes the call at Close when `session.close` asks (docs/DEEDS.md); older nodes leave it out. */
  deeds: z.boolean().optional(),
  /** This node has a Library (docs/LIBRARY.md); older nodes leave it out. */
  library: LibraryInfo.optional(),
});
export type NodeHello = z.infer<typeof NodeHello>;

/**
 * A problem the node can't report as a session envelope, e.g. a command for a session it doesn't have
 * (after a restart). Never stored: the hub relays it as `{ kind: 'error' }` to the session's subscribers,
 * or to every client when there is no session.
 */
export const NodeError = z.object({
  kind: z.literal('node-error'),
  session: z.uuid().optional(),
  message: z.string(),
});
export type NodeError = z.infer<typeof NodeError>;

/** A session the node's engine ran outside the bridge, e.g. in a terminal. */
export const ExternalSession = z.object({
  id: z.uuid(),
  cwd: z.string(),
  title: z.string(),
  updatedAt: z.number().int(), // epoch ms of its last change
  messages: z.number().int().nonnegative(),
});
export type ExternalSession = z.infer<typeof ExternalSession>;

/** A folder on the node a session can start in, for the New session picker. */
export const Project = z.object({
  path: z.string(),
  name: z.string(),
  lastUsed: z.number().int().optional(), // epoch ms, from the node's session transcripts
});
export type Project = z.infer<typeof Project>;

/** Node -> hub: the node's project folders, replacing the previous list. */
/** The agent CLI's version on this node, sent on connecting and whenever it changes. */
export const NodeCli = z.object({ kind: z.literal('cli'), version: z.string().max(64) });
export type NodeCli = z.infer<typeof NodeCli>;

/**
 * Hub -> node: run the agent CLI's own update. A frame of its own rather than a `NodeCommand`, so a client can't send
 * it over the socket: the hub's route is the only way in, and the node takes nothing from it but this id.
 */
export const HubCliUpdate = z.object({ kind: z.literal('cli-update'), requestId: z.uuid() });
export type HubCliUpdate = z.infer<typeof HubCliUpdate>;

/** The longest folder a `list-inventory` frame names, in characters. */
export const MAX_LIST_CWD = 4096;

/** Hub -> node: what could a Quest use in this folder? No folder means the node's home. Nothing is started for it. */
export const HubListInventory = z.object({
  kind: z.literal('list-inventory'),
  requestId: z.uuid(),
  cwd: z.string().min(1).max(MAX_LIST_CWD).optional(),
});
export type HubListInventory = z.infer<typeof HubListInventory>;

/** Node -> hub: a `list-inventory` answered, with engine events for the client to read; no `events` means it couldn't. */
export const NodeInventoryListed = z.object({
  kind: z.literal('inventory-listed'),
  requestId: z.uuid(),
  events: z.array(z.object({ engine: z.string(), raw: z.unknown() })).optional(),
});
export type NodeInventoryListed = z.infer<typeof NodeInventoryListed>;

/** The longest `reason` a `cli-updated` frame carries, in characters. */
export const MAX_CLI_UPDATE_REASON = 1000;

/** Node -> hub: a `cli-update` answered. `version` is the CLI's version afterwards; `reason` says why it failed. */
export const NodeCliUpdated = z.object({
  kind: z.literal('cli-updated'),
  requestId: z.uuid(),
  ok: z.boolean(),
  version: z.string().max(64).optional(),
  reason: z.string().max(MAX_CLI_UPDATE_REASON).optional(),
});
export type NodeCliUpdated = z.infer<typeof NodeCliUpdated>;

/** A release's version. Kingdoms make a URL and a folder name of it, so this is strict about what it lets through. */
export const ReleaseVersion = z
  .string()
  .max(64)
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/);

/**
 * Hub -> node: the Kingdom release to run, sent after a `hello` that offers `selfUpdate`. It's only ever a version: the
 * Kingdom fetches that release from the project and proves it's genuine by itself, and it never moves backwards. No
 * version means none is wanted, which stops an update under way.
 */
export const HubKingdomVersion = z.object({ kind: z.literal('kingdom-version'), version: ReleaseVersion.optional() });
export type HubKingdomVersion = z.infer<typeof HubKingdomVersion>;

export const SelfUpdateStep = z.enum(['installing', 'waiting', 'restarting', 'failed']);
export type SelfUpdateStep = z.infer<typeof SelfUpdateStep>;

/** Node -> hub: how the move to a `kingdom-version` is going, for the Castle. Lasts as long as the connection. */
export const NodeSelfUpdate = z.object({
  kind: z.literal('self-update'),
  version: ReleaseVersion,
  state: SelfUpdateStep,
  reason: z.string().max(MAX_CLI_UPDATE_REASON).optional(),
});
export type NodeSelfUpdate = z.infer<typeof NodeSelfUpdate>;
/** Where a Kingdom's own update stands, without the frame around it. */
export type SelfUpdate = Omit<NodeSelfUpdate, 'kind'>;

const VERSION_PARTS = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/;

/** Dot-separated pre-release parts, numbers as numbers, as semver orders them. */
function comparePrerelease(a: string, b: string): number {
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const order = (left[i] ?? '').localeCompare(right[i] ?? '', 'en', { numeric: true });
    if (order !== 0) return order;
  }
  return 0;
}

/** Whether release `a` is older than `b`. Only versions can be ordered, so anything else (a commit, `dev`) never is. */
export function isOlderVersion(a: string | undefined, b: string | undefined): boolean {
  const left = a && VERSION_PARTS.exec(a);
  const right = b && VERSION_PARTS.exec(b);
  if (!left || !right) return false;
  for (const part of [1, 2, 3]) {
    const order = Number(left[part]) - Number(right[part]);
    if (order !== 0) return order < 0;
  }
  if (left[4] === undefined) return false;
  if (right[4] === undefined) return true;
  return comparePrerelease(left[4], right[4]) < 0;
}

/** Node -> hub: the Summons this Kingdom may use, replacing the previous list. */
export const NodeSummons = z.object({ kind: z.literal('summons'), summons: z.array(Summon) });
export type NodeSummons = z.infer<typeof NodeSummons>;

/** Node -> hub: a Cast as it stands now. Resent after each connect, so the hub keeps what it hasn't heard. */
export const NodeCast = z.object({ kind: z.literal('cast'), cast: Cast });
export type NodeCast = z.infer<typeof NodeCast>;

export const NodeProjects = z.object({ kind: z.literal('projects'), projects: z.array(Project) });
export type NodeProjects = z.infer<typeof NodeProjects>;

/** Node -> hub: the node's current list of external sessions, replacing the previous one. */
export const NodeExternal = z.object({ kind: z.literal('external'), sessions: z.array(ExternalSession) });
export type NodeExternal = z.infer<typeof NodeExternal>;

/**
 * Node -> hub -> the client that asked: a `file.read` answered. `path` is relative to the session's folder; a text file
 * over the node's size cap comes back cut, with `truncated`. When `ok` is false, `reason` says why, in plain words.
 */
export const FileReply = z.object({
  kind: z.literal('file'),
  requestId: z.uuid(),
  ok: z.boolean(),
  path: z.string().optional(),
  content: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
  reason: z.string().optional(),
});
export type FileReply = z.infer<typeof FileReply>;

export const HubAck = z.object({ kind: z.literal('ack'), session: z.uuid(), seq: z.number().int() });
export type HubAck = z.infer<typeof HubAck>;

// client -> hub
export const ClientMessage = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('subscribe'), session: z.uuid(), fromSeq: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('command'), command: NodeCommand }),
  /** Is this link still alive? The hub answers `PONG_FRAME`; a hub older than this drops the frame and says nothing. */
  z.object({ kind: z.literal('ping') }),
  /** The client opens or closes the Library on a Kingdom, so the hub knows who wants `library-changed`. A hub older than this drops it. */
  z.object({ kind: z.literal('library-watch'), node: z.string(), open: z.boolean() }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/** The hub's answer to a client's `ping`, as sent. Not a `HubToClient`: only a client that pinged ever gets one. */
export const PONG_FRAME = '{"kind":"pong"}';

// hub -> client
/**
 * Hub -> every client, whatever it subscribed to: a session needs the user (a permission or question request), finished
 * a turn, or failed. `detail` is the tool name or a short summary; clients decide what to show, per Kingdom and device.
 */
export const Attention = z.object({
  kind: z.literal('attention'),
  node: z.string(),
  session: z.uuid(),
  label: z.string(),
  /** The plain form of a title the Quest gave itself, for a device on the Classic theme (#287). */
  plainLabel: z.string().optional(),
  reason: z.enum(['needs-you', 'done', 'failed', 'cast-done', 'cast-failed']),
  detail: z.string().optional(),
  /** On a done turn: how many Errands that turn left, #288. */
  errands: z.number().int().positive().optional(),
});
export type Attention = z.infer<typeof Attention>;

/**
 * A subscription's replay of stored events, in batches; `total` is how many the whole replay holds, for progress.
 * Streaming fragments of finished turns are left out (the full messages carry the same text).
 */
export const EventsFrame = z.object({
  kind: z.literal('events'),
  session: z.uuid(),
  events: z.array(Envelope),
  total: z.number().int().nonnegative(),
});
export type EventsFrame = z.infer<typeof EventsFrame>;

/** An `EventsFrame` with its events still unread, so one a client can't read costs that event and not the batch. */
export const UnreadEventsFrame = EventsFrame.extend({ events: z.array(z.unknown()) });
export type UnreadEventsFrame = z.infer<typeof UnreadEventsFrame>;

export const HubToClient = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('event'), event: Envelope }),
  EventsFrame,
  /** The replay is complete; `seq` is the session's last stored seq (-1 for none), even if that event was left out. */
  z.object({ kind: z.literal('synced'), session: z.uuid(), seq: z.number().int().min(-1) }),
  z.object({ kind: z.literal('error'), message: z.string() }),
  Attention,
  /** The user's appearance changed on another device; clients that don't know this frame ignore it. */
  z.object({ kind: z.literal('appearance'), appearance: Appearance }),
  /** The user viewed this finished Quest on another tab or device; clients that don't know this frame ignore it. */
  z.object({ kind: z.literal('seen'), session: z.uuid() }),
  /** The answer to this client's `file.read`; clients that don't know this frame ignore it. */
  FileReply,
  /** A Cast changed; clients that don't know this frame ignore it. */
  z.object({ kind: z.literal('cast'), node: z.string(), cast: Cast }),
  /** A Kingdom's Scouts changed; clients that don't know this frame ignore it. */
  ScoutsFrame,
  /** A Scout's run ended, with its Board as it now stands; clients that don't know this frame ignore it. */
  BoardFrame,
  /** Items on a Board changed state; clients that don't know this frame ignore it. */
  BoardItemsFrame,
  /** A Kingdom's Patrols changed; clients that don't know this frame ignore it. */
  PatrolsFrame,
  /** A Patrol's run started or ended; clients that don't know this frame ignore it. */
  PatrolRunsFrame,
  /** A Kingdom's Errands changed; clients that don't know this frame ignore it. */
  ErrandsFrame,
  /** Rows of a Kingdom's Deeds feed were added or changed; clients that don't know this frame ignore it. */
  DeedsFrame,
  /** Files in a Kingdom's Library changed; clients that don't know this frame ignore it. */
  LibraryChangedFrame,
]);
export type HubToClient = z.infer<typeof HubToClient>;

/** The repository whose releases Kingdoms run. A fork changes this. */
export const RELEASE_REPO = 'crystal-bridge/crystal-bridge';

/** The two packages a release carries: the Kingdom's and the hub's. */
export type ReleasePackage = 'kingdom' | 'airship';

/** A package's file name in a release. */
export function releaseTarballName(pkg: ReleasePackage, version: string): string {
  return `crystal-bridge-${pkg}-${version}.tgz`;
}

/** Where a release keeps a package. */
export function releaseTarballUrl(pkg: ReleasePackage, version: string): string {
  return `https://github.com/${RELEASE_REPO}/releases/download/v${version}/${releaseTarballName(pkg, version)}`;
}

/** The Kingdom package's file name in a release. */
export function kingdomTarballName(version: string): string {
  return releaseTarballName('kingdom', version);
}

/** Where a release keeps the Kingdom package. */
export function kingdomTarballUrl(version: string): string {
  return releaseTarballUrl('kingdom', version);
}

/** The hub's container image at a release, under the same owner as the repository. */
export function hubImage(version: string): string {
  return `ghcr.io/${RELEASE_REPO.split('/')[0]}/airship:${version}`;
}

/**
 * What Add Kingdom installs: this release's tarball on GitHub until the package is on npm. A fork points this at its own
 * release. A test keeps it on the Kingdom package's version.
 */
export const KINGDOM_PACKAGE = kingdomTarballUrl('0.7.0');

/** The one command that turns a machine into a Kingdom of this hub. */
export function joinCommand(hub: string, code: string): string {
  return `npx --yes --package=${KINGDOM_PACKAGE} crystal-bridge-kingdom join ${hub} ${code}`;
}

/** What removes a joined Kingdom from its machine. Run with node: an npx install leaves no command on the PATH. */
export const LEAVE_COMMAND =
  'node ~/.local/share/crystal-bridge/current/node_modules/@crystal-bridge/kingdom/dist/main.js leave';

/** The same on Windows. `cmd /c` expands the folder in any shell, PowerShell included. */
export const LEAVE_COMMAND_WINDOWS =
  'cmd /c node "%LOCALAPPDATA%\\crystal-bridge\\current\\node_modules\\@crystal-bridge\\kingdom\\dist\\main.js" leave';
