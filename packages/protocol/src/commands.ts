import { z } from 'zod';
import { Appearance } from './appearance.js';
import { Envelope } from './envelope.js';

/**
 * The CLI's permission modes a client may pick. `manual` asks for every action, `auto` lets the CLI's own
 * classifier decide and ask only when unsure. Modes that turn approvals off (bypassPermissions, dontAsk) are left
 * out on purpose: a click in the hub must never remove them.
 */
export const PermissionMode = z.enum(['manual', 'acceptEdits', 'auto', 'plan']);
export type PermissionMode = z.infer<typeof PermissionMode>;

/**
 * How a node runs a session's engine. `stream` drives `claude -p` over stream-json (the default); `interactive` runs
 * the real interactive `claude` in a pseudo-terminal, for the tools only an interactive session gets (e.g. artifacts).
 */
export const Engine = z.enum(['stream', 'interactive']);
export type Engine = z.infer<typeof Engine>;

/** How hard the agent thinks: the CLI's `--effort` levels. Unset leaves the CLI's own default. */
export const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof Effort>;

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
  }),
  z.object({
    /** Switches a session's permission mode; a running process changes at once, otherwise on its next start. */
    type: z.literal('session.mode'),
    session: z.uuid(),
    mode: PermissionMode,
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
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

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
  reason: z.enum(['needs-you', 'done', 'failed', 'cast-done', 'cast-failed']),
  detail: z.string().optional(),
});
export type Attention = z.infer<typeof Attention>;

export const HubToClient = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('event'), event: Envelope }),
  /**
   * A subscription's replay of stored events, in batches; `total` is how many the whole replay holds, for progress.
   * Streaming fragments of finished turns are left out (the full messages carry the same text).
   */
  z.object({
    kind: z.literal('events'),
    session: z.uuid(),
    events: z.array(Envelope),
    total: z.number().int().nonnegative(),
  }),
  /** The replay is complete; `seq` is the session's last stored seq (-1 for none), even if that event was left out. */
  z.object({ kind: z.literal('synced'), session: z.uuid(), seq: z.number().int().min(-1) }),
  z.object({ kind: z.literal('error'), message: z.string() }),
  Attention,
  /** The user's appearance changed on another device; clients that don't know this frame ignore it. */
  z.object({ kind: z.literal('appearance'), appearance: Appearance }),
  /** The answer to this client's `file.read`; clients that don't know this frame ignore it. */
  FileReply,
  /** A Cast changed; clients that don't know this frame ignore it. */
  z.object({ kind: z.literal('cast'), node: z.string(), cast: Cast }),
]);
export type HubToClient = z.infer<typeof HubToClient>;

/** The repository whose releases Kingdoms run. A fork changes this. */
export const RELEASE_REPO = 'crystal-bridge/crystal-bridge';

/** The Kingdom package's file name in a release. */
export function kingdomTarballName(version: string): string {
  return `crystal-bridge-kingdom-${version}.tgz`;
}

/** Where a release keeps the Kingdom package. */
export function kingdomTarballUrl(version: string): string {
  return `https://github.com/${RELEASE_REPO}/releases/download/v${version}/${kingdomTarballName(version)}`;
}

/** The hub's container image at a release, under the same owner as the repository. */
export function hubImage(version: string): string {
  return `ghcr.io/${RELEASE_REPO.split('/')[0]}/airship:${version}`;
}

/**
 * What Add Kingdom installs: this release's tarball on GitHub until the package is on npm. A fork points this at its own
 * release. A test keeps it on the Kingdom package's version.
 */
export const KINGDOM_PACKAGE = kingdomTarballUrl('0.5.0');

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
