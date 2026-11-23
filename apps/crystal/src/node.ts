import { randomUUID } from 'node:crypto';
import {
  HubAck,
  HubCliUpdate,
  HubListInventory,
  HubKingdomVersion,
  HubPatrolChange,
  HubPatrolDraft,
  HubPatrolPreview,
  HubPatrolRunNow,
  HubScoutAction,
  HubScoutQuest,
  HubScoutRunNow,
  type NodePatrolChanged,
  type NodePatrolDrafted,
  type NodePatrolPreviewed,
  type PatrolDraft,
  type NodePatrolRun,
  type NodePatrols,
  type Patrol,
  type PatrolChangeRequest,
  type PatrolLink,
  type PatrolRun,
  type NodeScoutActed,
  MAX_CLI_UPDATE_REASON,
  NodeCliUpdated,
  NodeInventoryListed,
  NodeCommand,
  NodeError,
  NodeHello,
  NodeSelfUpdate,
  PROTOCOL_VERSION,
  keepBeating,
  type Attachment,
  type Effort,
  type Envelope,
  type EventType,
  type Resume,
  type SelfUpdate,
  type NodeExternal,
  NodeCli,
  type NodeProjects,
  type Project,
  type PermissionMode,
  type ExternalSession,
  type Engine,
  type FileReply,
  type Cast,
  type NodeCast,
  type NodeSummons,
  type Summon,
  type NodeScoutRun,
  type NodeScouts,
  type Scout,
  type ScoutItem,
  type ScoutLink,
  type ScoutRun,
  type QuestTitledPayload,
  MAX_DEEDS_PER_TURN,
  MAX_ERRANDS_PER_TURN,
  MAX_TALLY_PRS,
  lootPath,
  lootPaths,
  trophyLinks,
} from '@crystal-bridge/protocol';
import { ATTACHMENTS_DIR, attachmentDir, removeAttachments, saveAttachments, withAttachments } from './attachments.js';
import { WebSocket } from 'ws';
import { readSessionFile } from './files.js';
import type { PermissionDecision, PermissionRequest } from './permissions.js';
import type { ReplayEvent } from './transcripts.js';
import type { ClaudeSessionEvent } from './session.js';
import type { ActResult, QuestStart } from './scouts.js';
import { summaryLine, type ChangeResult, type PatrolQuestStart, type QuestEnded } from './patrols.js';
import { preview } from './recurrence.js';

/** The subset of `ClaudeSession` the node link drives, so tests can supply a fake. */
export interface SessionLike {
  start(prompt: string): void;
  send(text: string): void;
  interrupt(): void;
  setMode(mode: PermissionMode): void;
  /** Changes the effort for later processes. */
  setEffort?(effort: Effort | undefined): void;
  /** Answers a terminal that's asking something; only the interactive engine has one. */
  keys?(input: { keys?: string; retype?: boolean }): void;
  close(): void;
  /** Resolves once the session's process has exited (at once if none is running). */
  stopped?(): Promise<void>;
  /** Mid-turn, including waiting on an approval. */
  readonly busy: boolean;
  /** Why `busy` holds, in a few words. */
  readonly busyReason?: string;
  on(event: 'event', listener: (event: ClaudeSessionEvent) => void): void;
}

/** What `GET /status` on Crystal's local port reports, e.g. for a deploy deciding when to restart. */
export interface NodeStatus {
  node: string;
  sessions: number;
  /** Ids of sessions that are mid-turn. */
  busy: string[];
  /** Why each busy session counts as busy, by id. */
  reasons: Record<string, string>;
}

export type SessionFactory = (opts: {
  session: string;
  cwd: string;
  permissionUrl: string;
  permissionMode: PermissionMode;
  /** Start as a fork of this session (see `session.start`'s `forkFrom`). */
  forkFrom?: string;
  /** Which engine runs it; unset is `stream`. Only engines in `StartNodeOptions.engines` reach the factory. */
  engine?: Engine;
  /** `--effort` for every process it starts; unset is the CLI's default. */
  effort?: Effort;
  /** Folders outside `cwd` it may read without asking: the session's attached files. */
  addDirs?: string[];
}) => SessionLike;

/** All `startNode` needs from Task 4's permission server. */
export interface PermissionServerLike {
  url(session: string): string;
}

export interface StartNodeOptions {
  hubUrl: string;
  node: string;
  /** This node's token from the Airship's `node:add`, sent as a bearer header. */
  token?: string;
  sessionFactory: SessionFactory;
  permissionServer: PermissionServerLike;
  /** Sessions the engine ran outside the bridge, reported to the hub and adoptable from it. */
  transcripts?: TranscriptSource;
  /** The agent CLI's version, reported to the hub; asked often, so it should cache unless `fresh`. */
  cliVersion?: (fresh?: boolean) => Promise<string | undefined>;
  /** Runs the agent CLI's own update (`cli-version.ts` in production); without it, the hub isn't offered one. */
  updateCli?: () => Promise<void>;
  /** Lists what a Quest could use in a folder, or the home folder, as engine events; unset on a node that can't. */
  listInventory?: (cwd?: string) => Promise<NodeInventoryListed['events']>;
  /** Follows the release the hub names (`self-update.ts` in production); without it, hello doesn't offer to. */
  onKingdomVersion?: (version: string | undefined) => void;
  /** Mode for sessions started without one, and for ones rebuilt after a restart. Default: manual. */
  defaultMode?: PermissionMode;
  /** Engines this node runs sessions on, advertised in hello; unset means just `stream` (and hello omits it). */
  engines?: Engine[];
  /** This agent's release (the deployed commit), reported in hello for display. */
  release?: string;
  /** Makes a session's worktree (`worktree.ts` in production); without it, worktree starts are refused. */
  worktrees?: (cwd: string, session: string) => Promise<{ path: string; root: string; branch: string }>;
  /** Removes a closed session's worktree (`worktree.ts` in production), keeping one with uncommitted changes. */
  removeWorktree?: (cwd: string) => Promise<{ removed: boolean; reason?: string }>;
  /** Where files sent with prompts are kept (one folder per session); default `ATTACHMENTS_DIR`. */
  attachmentsDir?: string;
  /** The node's project folders for the New session picker, reported with the transcripts scan. */
  projects?: () => Promise<Project[]>;
  /** This Kingdom's Summons and Casts, told to the hub on each connect; without it, none are mentioned. */
  summons?: { list(): Summon[]; casts(): Cast[] };
  /** This Kingdom's Scouts (`scouts.ts`), told to the hub with their latest runs on each connect; unset runs none. */
  scouts?: {
    list(): Scout[];
    recent(): NodeScoutRun[];
    runNow(id: string): void;
    act(request: HubScoutAction, startQuest: (start: QuestStart) => Promise<ActResult>): Promise<ActResult>;
    quest(request: HubScoutQuest, startQuest: (start: QuestStart) => Promise<ActResult>): Promise<ActResult>;
    draft(request: HubPatrolDraft): { ok: true; draft: PatrolDraft } | { ok: false; reason: string };
  };
  /** This Kingdom's Patrols (`patrols.ts`), told to the hub with their latest runs on each connect; unset runs none. */
  patrols?: {
    list(): Patrol[];
    recent(): NodePatrolRun[];
    runNow(id: string): void;
    change(id: string, change: PatrolChangeRequest): Promise<ChangeResult>;
    /** A Patrol's Quest's first turn ended. */
    questEnded(session: string, ended: QuestEnded): void;
    /** Whether the app may save Patrols here, said in hello. */
    fromApp(): boolean;
  };
  /** How often to rescan `transcripts`; the hub only hears about a change. Default 60 s. */
  scanMs?: number;
  /** How often to check the hub is still there. Default `HEARTBEAT_MS`. */
  heartbeatMs?: number;
}

/** Where `startNode` finds sessions run outside the bridge (`transcripts.ts` in production). */
export interface TranscriptSource {
  list(): Promise<ExternalSession[]>;
  load(id: string): Promise<{ summary: ExternalSession; events: ReplayEvent[] } | undefined>;
}

const DEFAULT_SCAN_MS = 60_000;

export interface CrystalNode {
  /** Wired as a Task 4 `onRequest`: turns a prompt into a `permission.request` envelope. */
  handlePermissionRequest(request: PermissionRequest): Promise<PermissionDecision>;
  status(): NodeStatus;
  /** Tells the hub how this Kingdom's own update is going, for the Castle. */
  reportSelfUpdate(state: SelfUpdate): void;
  /** Tells the hub how a Cast stands. A frame lost to a dropped connection is sent again on the next connect. */
  reportCast(cast: Cast): void;
  /** Tells the hub the machine list changed. A frame lost to a dropped connection is sent again on the next connect. */
  reportSummons(summons: Summon[]): void;
  /** Tells the hub the Scouts changed. The list goes again on the next connect. */
  reportScouts(scouts: Scout[]): void;
  /** Tells the hub a Scout's run ended. The latest runs go again on the next connect; the hub ignores repeats. */
  reportScoutRun(scout: string, run: ScoutRun, items: ScoutItem[] | undefined): void;
  /** Tells the hub the Patrols changed. The list goes again on the next connect. */
  reportPatrols(patrols: Patrol[]): void;
  /** Tells the hub a Patrol's run set out or ended. The latest runs go again on the next connect. */
  reportPatrolRun(patrol: string, run: PatrolRun): void;
  /**
   * Starts a Patrol's Quest as New Quest would, marked with its run. Its first turn's end goes to `patrols.questEnded`,
   * and until then a permission prompt nobody answers within `waitForYouMs` is denied and the turn ended.
   */
  startPatrolQuest(start: PatrolQuestStart): Promise<{ ok: true; session: string } | { ok: false; reason: string }>;
  /** Stops treating a Quest as its Patrol's: its prompts wait as long as any Quest's, and its end reports nothing. */
  forgetPatrolQuest(session: string): void;
  /** Whether a session is open here, so only a real Quest can use the `summon` tool. */
  holds(session: string): boolean;
  /** Passes on the name a Quest gave itself (the `title` tool, #287), or says why not: it isn't a Quest here. */
  titleQuest(session: string, title: QuestTitledPayload): string | undefined;
  /** Passes on a step a Quest left the user (the `errand` tool, #288), or says why not. */
  leaveErrand(
    session: string,
    errand: { title: string; body: string },
  ): { ok: true; id: string } | { ok: false; reason: string };
  /** Passes on a Deed a Quest records (the `deed` tool, #289), at most 3 a turn, or says why not. */
  recordDeed(
    session: string,
    deed: { deed: string; detail?: string },
  ): { ok: true; id: string } | { ok: false; reason: string };
  /**
   * Closes every session, stops reconnecting and closes the socket. Resolves once the sessions' processes have
   * stopped (each engine escalates to SIGTERM after its grace period), or after `CLOSE_WAIT_MS` regardless, so a
   * shutting-down Crystal doesn't exit leaving its claude processes orphaned.
   */
  close(): Promise<void>;
}

/** Within systemd's TimeoutStopSec (15 s): the engines' own grace periods (5 s) fit inside it. */
const CLOSE_WAIT_MS = 10_000;

/** Close code from a hub that doesn't speak this node's protocol version. */
const CLOSE_WRONG_PROTOCOL = 4006;
/** Close code for a node whose id another Crystal holds and is still answering on: a clone, or a leftover service. */
const CLOSE_DUPLICATE_NODE = 4009;

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
/**
 * The hub never says it accepted a hello, it only closes on one it refuses, so a link that lasts this long counts as
 * accepted. Backing off until then keeps a refused Kingdom from redialling every second against the hub's dial limit.
 */
const ACCEPTED_AFTER_MS = 5000;

interface SessionState {
  seq: number;
  unacked: Map<number, Envelope>;
  runtime: SessionLike;
  cwd: string;
  /** Closed on purpose: kept only so its last envelopes still get acked; takes no more commands. */
  closed?: boolean;
}

/** Stands in for the runtime of a session closed after a restart, when there is no process to drive. */
const CLOSED_RUNTIME: SessionLike = {
  start() {},
  send() {},
  interrupt() {},
  setMode() {},
  close() {},
  busy: false,
  on() {},
};

type PermissionResolver = (
  behavior: 'allow' | 'deny',
  message: string | undefined,
  answers?: Record<string, string>,
) => void;

interface PendingPermission {
  session: string;
  resolve: PermissionResolver;
}

/** A Patrol's Quest whose first turn hasn't ended: its prompts wait only so long, and its end is the run's outcome. */
interface PatrolQuest {
  waitForYouMs: number;
  /** A prompt outwaited `waitForYouMs`, so the turn was ended. */
  timedOut?: boolean;
}

/** The longest delay `setTimeout` keeps: 2^31 - 1 ms, about 24.8 days. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** `waitForYou` as the run's reason says it: `30m`, `2h`, or seconds for a short one. */
function waitedFor(ms: number): string {
  if (ms >= MAX_TIMER_MS) return 'about 24 days';
  for (const [unit, size] of [
    ['d', 86_400_000],
    ['h', 3_600_000],
    ['m', 60_000],
  ] as const)
    if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
  return `${Math.round(ms / 100) / 10}s`;
}

/** The deny message for a prompt whose `claude` process (or the whole node) went away first. */
const SESSION_ENDED_MESSAGE = 'Session ended before an answer';

/** A frame's `kind` or `type`, as far as one is safe to repeat: a short name, so never a prompt that landed there. */
function isFrameName(part: unknown): part is string {
  return typeof part === 'string' && /^[\w.-]{1,64}$/.test(part);
}

/** First 60 chars of the prompt's first line, for the session list in the client. */
function labelFromPrompt(prompt: string): string {
  const firstLine = prompt.split('\n', 1)[0] ?? '';
  return firstLine.slice(0, 60);
}

/**
 * The last line of defence for a rejection nothing caught: by default Node ends the process, and every Quest on this
 * Kingdom with it, which costs far more than whatever was being tried.
 */
export function surviveRejections(target: Pick<NodeJS.EventEmitter, 'on'>): void {
  target.on('unhandledRejection', (reason) => console.error('[crystal] unhandled rejection', reason));
}

export function startNode(options: StartNodeOptions): CrystalNode {
  const {
    hubUrl,
    node: nodeId,
    token,
    sessionFactory,
    permissionServer,
    transcripts,
    projects,
    worktrees,
    removeWorktree,
    attachmentsDir = ATTACHMENTS_DIR,
    defaultMode = 'manual',
    engines,
  } = options;

  const sessions = new Map<string, SessionState>();
  const pendingPermissions = new Map<string, PendingPermission>();
  const patrolQuests = new Map<string, PatrolQuest>();
  /** Errands each Quest has left this turn; in memory only, counted again once the turn or process ends. */
  const errandsThisTurn = new Map<string, number>();
  const deedsThisTurn = new Map<string, number>();
  /** Each Quest's Loot and Trophies so far this turn, by the shared rules, for its `turn.tally`. */
  const turnLoot = new Map<string, { files: Set<string>; prs: Set<string> }>();
  /** A finished turn's Loot and Trophies, under its `turn.finished`'s seq, until its diff is in. */
  const finishedLoot = new Map<string, { seq: number; files: Set<string>; prs: Set<string> }>();
  /** Patrol Quests let go while they were still starting, so they aren't watched once they've started. */
  const forgottenQuests = new Set<string>();

  let socket: WebSocket | null = null;
  let closed = false;
  let backoffMs = INITIAL_BACKOFF_MS;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let lastExternal: string | null = null;
  let lastProjects: string | null = null;
  let lastCli: string | undefined;
  let updatingCli = false;

  function log(message: string, detail?: unknown): void {
    if (detail !== undefined) {
      console.error(`[crystal:node] ${message}`, detail);
    } else {
      console.error(`[crystal:node] ${message}`);
    }
  }

  function wsSend(data: unknown): void {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(data));
    }
  }

  /** Sends an event in a session's stream; returns the seq it went out under. */
  function sendEnvelope(sessionId: string, type: EventType, payload: unknown): number {
    const state = sessions.get(sessionId);
    const seq = state ? state.seq++ : 0;
    const envelope: Envelope = { node: nodeId, session: sessionId, seq, ts: Date.now(), type, payload };
    if (state) state.unacked.set(seq, envelope);
    wsSend(envelope);
    return seq;
  }

  /**
   * A command named a session this node doesn't have. Not an envelope: any seq we picked could collide
   * with one the hub already stored for that session, and the hub would drop it silently.
   */
  function sendNodeError(sessionId: string | undefined, message: string): void {
    const frame: NodeError = { kind: 'node-error', message };
    if (sessionId !== undefined) frame.session = sessionId;
    wsSend(frame);
  }

  /**
   * A frame this release can't read, from a newer hub or tab. A command gets an answer when it names a session, or its
   * tab would wait forever. Only the frame's name is logged or sent back: the rest may hold prompt text.
   */
  function refuseUnreadable(parsed: unknown): void {
    const frame = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
    const name = [frame.kind, frame.type].find(isFrameName) ?? 'unnamed';
    log(`dropped unrecognized frame from hub: ${name}`);
    if (typeof frame.type !== 'string' || frame.kind !== undefined) return;
    const session = NodeError.shape.session.safeParse(frame.session).data;
    if (session) sendNodeError(session, `this Kingdom can't read that command (${name}): it may need an update`);
  }

  /**
   * Says on a Quest's record that something failed, or as a node error if it has none yet (see `sendNodeError`).
   * True when it was recorded.
   */
  function reportFailure(sessionId: string, error: unknown): boolean {
    log(`a command for ${sessionId} failed`, error);
    const message = error instanceof Error ? error.message : String(error);
    if (sessions.has(sessionId)) {
      sendEnvelope(sessionId, 'error', { message });
      return true;
    }
    sendNodeError(sessionId, message);
    return false;
  }

  /** Ends one Quest's run after a failure, so it shows as over and the other Quests carry on. */
  function failSession(sessionId: string, error: unknown): void {
    denyPending(sessionId);
    if (!reportFailure(sessionId, error)) return;
    sendEnvelope(sessionId, 'session.ended', { exitCode: null, signal: null, reason: 'error' });
  }

  function resendUnacked(): void {
    for (const state of sessions.values()) {
      const pending = [...state.unacked.values()].sort((a, b) => a.seq - b.seq);
      for (const envelope of pending) {
        wsSend(envelope);
      }
    }
  }

  function handleAck(ack: HubAck): void {
    sessions.get(ack.session)?.unacked.delete(ack.seq);
  }

  /** Whether this node runs an engine: the default always, others only if its hello lists them. */
  function runs(engine: Engine | undefined): boolean {
    return !engine || engine === 'stream' || Boolean(engines?.includes(engine));
  }

  /** Adds the files a forwarded line's file tools wrote and the pull requests it printed to its Quest's turn. */
  function tallyLoot(sessionId: string, cwd: string, raw: unknown): void {
    const paths = lootPaths(raw);
    const links = trophyLinks(raw);
    if (!paths.length && !links.length) return;
    let loot = turnLoot.get(sessionId);
    if (!loot) turnLoot.set(sessionId, (loot = { files: new Set(), prs: new Set() }));
    for (const path of paths) loot.files.add(lootPath(path, cwd));
    for (const link of links) loot.prs.add(link);
  }

  /** The finished turn's diff is in: its `turn.tally`, counting files as the browser counts Loot. */
  function sendTally(sessionId: string, diff: string[] | undefined): void {
    const loot = finishedLoot.get(sessionId);
    if (!loot) return;
    finishedLoot.delete(sessionId);
    for (const file of diff ?? []) loot.files.add(file);
    sendEnvelope(sessionId, 'turn.tally', {
      seq: loot.seq,
      files: loot.files.size,
      prs: [...loot.prs].slice(0, MAX_TALLY_PRS),
    });
  }

  /** Registers a session and wires its events through, numbering envelopes from `seq`. */
  function createSession(
    sessionId: string,
    cwd: string,
    seq: number,
    mode = defaultMode,
    forkFrom?: string,
    engine?: Engine,
    effort?: Effort,
  ): SessionLike {
    const permissionUrl = permissionServer.url(sessionId);
    // The session's folder for attached files exists before any process starts, so the agent can always read it.
    let addDirs: string[] = [];
    try {
      addDirs = [attachmentDir(sessionId, attachmentsDir)];
    } catch (error) {
      log(`no folder for attached files for ${sessionId}`, error);
    }
    const runtime = sessionFactory({
      session: sessionId,
      cwd,
      permissionUrl,
      permissionMode: mode,
      ...(forkFrom ? { forkFrom } : {}),
      ...(engine ? { engine } : {}),
      ...(effort ? { effort } : {}),
      ...(addDirs.length ? { addDirs } : {}),
    });
    sessions.set(sessionId, { seq, unacked: new Map(), runtime, cwd });

    runtime.on('event', (event: ClaudeSessionEvent) => {
      // The process that asked can no longer use an answer; deny so nothing stays pending forever.
      if (event.type === 'session.ended') denyPending(sessionId);
      if (event.type === 'turn.finished' || event.type === 'session.ended') {
        errandsThisTurn.delete(sessionId);
        deedsThisTurn.delete(sessionId);
      }
      if (event.type === 'turn.tally') {
        sendTally(sessionId, event.payload.files);
        return;
      }
      if (event.type === 'claude.event') tallyLoot(sessionId, cwd, event.payload.raw);
      const seq = sendEnvelope(sessionId, event.type, event.payload);
      if (event.type === 'turn.finished') {
        const loot = turnLoot.get(sessionId) ?? { files: new Set<string>(), prs: new Set<string>() };
        turnLoot.delete(sessionId);
        finishedLoot.set(sessionId, { seq, ...loot });
      }
      watchPatrolQuest(sessionId, event);
    });
    return runtime;
  }

  async function handleSessionStart(cmd: Extract<NodeCommand, { type: 'session.start' }>): Promise<void> {
    const started = await startSession(cmd);
    if (!started.ok && started.reason) sendNodeError(cmd.session, started.reason);
  }

  /**
   * Starts a session, as New Quest asks or a Scout's `quest` action does. `scout` is the item a Quest came from. Says
   * why not when it can't; a reason left out means nothing needs saying.
   */
  async function startSession(
    cmd: Extract<NodeCommand, { type: 'session.start' }> & { scout?: ScoutLink; patrol?: PatrolLink },
    onCreated?: () => void,
  ): Promise<{ ok: true } | { ok: false; reason?: string }> {
    // A second start would spawn another claude for the same conversation and restart seq at 0.
    if (sessions.has(cmd.session)) {
      log(`ignored session.start for a session that already exists: ${cmd.session}`);
      return { ok: false, reason: `session already exists: ${cmd.session}` };
    }

    if (cmd.forkFrom && cmd.worktree) {
      return { ok: false, reason: 'a fork runs in its source session’s folder, not a new worktree' };
    }

    if (!runs(cmd.engine)) return { ok: false, reason: `this node does not run the ${cmd.engine} engine` };

    let cwd = cmd.cwd;
    let worktree: { root: string; branch: string } | undefined;
    if (cmd.worktree) {
      if (!worktrees) return { ok: false, reason: 'this node cannot create worktrees' };
      try {
        const made = await worktrees(cmd.cwd, cmd.session);
        cwd = made.path;
        worktree = { root: made.root, branch: made.branch };
      } catch (error) {
        return {
          ok: false,
          reason: `could not create a worktree: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      // Checked again: the same start may have arrived twice while the worktree was being made.
      if (sessions.has(cmd.session)) return { ok: false };
    }

    // Saved first: if they can't be, nothing starts.
    const prompt = withFiles(cmd.session, cmd.prompt, cmd.attachments);
    if (prompt === undefined) return { ok: false };
    const runtime = createSession(cmd.session, cwd, 0, cmd.mode, cmd.forkFrom, cmd.engine, cmd.effort);
    onCreated?.();
    sendEnvelope(cmd.session, 'session.started', {
      cwd,
      prompt,
      // A Board's Quests share one template, so each is named after its item.
      label: labelFromPrompt(cmd.scout?.title || cmd.prompt),
      mode: cmd.mode ?? defaultMode,
      ...(worktree ? { worktree } : {}),
      ...(cmd.forkFrom ? { forkedFrom: cmd.forkFrom } : {}),
      ...(cmd.engine ? { engine: cmd.engine } : {}),
      ...(cmd.effort ? { effort: cmd.effort } : {}),
      ...(cmd.scout ? { scout: cmd.scout } : {}),
      ...(cmd.patrol ? { patrol: cmd.patrol } : {}),
    });

    runtime.start(prompt);
    return { ok: true };
  }

  /** Starts the Quest a Scout's `quest` action asks for, the way New Quest starts one. */
  async function startQuest(start: QuestStart): Promise<ActResult> {
    const session = randomUUID();
    let started: Awaited<ReturnType<typeof startSession>>;
    try {
      started = await startSession({
        type: 'session.start',
        node: nodeId,
        session,
        cwd: start.cwd,
        prompt: start.prompt,
        ...(start.mode ? { mode: start.mode } : {}),
        ...(start.worktree ? { worktree: true } : {}),
        scout: start.from,
      });
    } catch (error) {
      // As for New Quest (#194): nothing is running the Quest, so it ends rather than looking alive.
      failSession(session, error);
      return {
        ok: false,
        reason: `the Quest did not start: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return started.ok ? { ok: true, session } : { ok: false, reason: started.reason ?? 'the Quest did not start' };
  }

  async function startPatrolQuest(
    start: PatrolQuestStart,
  ): Promise<{ ok: true; session: string } | { ok: false; reason: string }> {
    const session = start.session;
    let started: Awaited<ReturnType<typeof startSession>>;
    try {
      started = await startSession(
        {
          type: 'session.start',
          node: nodeId,
          session,
          cwd: start.cwd,
          prompt: start.prompt,
          ...(start.mode ? { mode: start.mode } : {}),
          ...(start.effort ? { effort: start.effort } : {}),
          ...(start.engine ? { engine: start.engine } : {}),
          ...(start.worktree ? { worktree: true } : {}),
          patrol: start.link,
        },
        // Watched before its process starts, so neither its first prompt nor a quick end slips past.
        () => {
          if (!forgottenQuests.delete(session)) patrolQuests.set(session, { waitForYouMs: start.waitForYouMs });
        },
      );
    } catch (error) {
      patrolQuests.delete(session);
      failSession(session, error);
      return {
        ok: false,
        reason: `the Quest did not start: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!started.ok) {
      patrolQuests.delete(session);
      return { ok: false, reason: started.reason ?? 'the Quest did not start' };
    }
    return { ok: true, session };
  }

  /** The end of a Patrol's Quest's first turn is its run's outcome; after that the Quest is the user's. */
  function watchPatrolQuest(session: string, event: ClaudeSessionEvent): void {
    const watched = patrolQuests.get(session);
    if (!watched) return;
    let ended: QuestEnded;
    if (watched.timedOut && (event.type === 'turn.finished' || event.type === 'session.ended')) {
      ended = {
        outcome: 'needs-you',
        reason: `a permission prompt waited ${waitedFor(Math.min(watched.waitForYouMs, MAX_TIMER_MS))} with nobody to answer it; send the Quest a message to carry on`,
      };
    } else if (event.type === 'turn.finished') {
      const outcome = event.payload.outcome;
      ended =
        outcome === 'success'
          ? { outcome: 'finished' }
          : outcome === 'error'
            ? { outcome: 'failed', reason: 'the Quest’s turn ended in an error' }
            : { outcome: 'failed', reason: 'the Quest was stopped' };
    } else if (event.type === 'session.ended') {
      ended = { outcome: 'failed', reason: 'the Quest ended before its turn did' };
    } else return;
    // What the reply came to, on any outcome whose turn carries one. The stream engine sends a reply only with a turn
    // that succeeded; the interactive engine sends whatever was written, so a Quest that needs you may say what it wanted.
    const said =
      event.type === 'turn.finished' && event.payload.summary !== undefined
        ? summaryLine(event.payload.summary)
        : undefined;
    if (said) ended.summary = said;
    patrolQuests.delete(session);
    options.patrols?.questEnded(session, ended);
  }

  /** Ends a Patrol's Quest's turn when a prompt in it waited `waitForYouMs` with nobody answering. */
  function timePatrolPrompt(requestId: string, session: string): (() => void) | undefined {
    const watched = patrolQuests.get(session);
    if (!watched) return undefined;
    const timer = setTimeout(
      () => {
        const pending = pendingPermissions.get(requestId);
        if (!pending || patrolQuests.get(session) !== watched) return;
        pendingPermissions.delete(requestId);
        watched.timedOut = true;
        pending.resolve(
          'deny',
          `Nobody answered this within ${waitedFor(Math.min(watched.waitForYouMs, MAX_TIMER_MS))}: this scheduled run stops here. Don't retry; end your turn.`,
        );
        try {
          sessions.get(session)?.runtime.interrupt();
        } catch (error) {
          log(`could not end the turn of ${session}`, error);
        }
      },
      // A longer delay than a timer holds would fire at once; past about 24 days it waits that long instead.
      Math.min(watched.waitForYouMs, MAX_TIMER_MS),
    );
    timer.unref?.();
    return () => clearTimeout(timer);
  }

  /** Carries out a change the app asked for; the answer always goes back, so the hub never waits on it. */
  async function handlePatrolChange(request: HubPatrolChange): Promise<void> {
    let answer: ChangeResult;
    try {
      answer = options.patrols
        ? await options.patrols.change(request.patrol, request.change)
        : { ok: false, reason: 'this Kingdom runs no Patrols' };
    } catch (error) {
      answer = { ok: false, reason: `the change failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    wsSend(
      (answer.ok
        ? { kind: 'patrol-changed', requestId: request.requestId, ok: true }
        : {
            kind: 'patrol-changed',
            requestId: request.requestId,
            ok: false,
            reason: answer.reason.slice(0, 2000),
          }) satisfies NodePatrolChanged,
    );
  }

  /** Carries out a Board's `quest` or `run` action; the answer always goes back, so the Board never waits on it. */
  async function handleScoutAction(request: HubScoutAction | HubScoutQuest): Promise<void> {
    let answer: ActResult;
    try {
      const scouts = options.scouts;
      answer = !scouts
        ? { ok: false, reason: 'this Kingdom runs no Scouts' }
        : request.kind === 'scout-quest'
          ? await scouts.quest(request, startQuest)
          : await scouts.act(request, startQuest);
    } catch (error) {
      answer = { ok: false, reason: `the action failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    const reply: NodeScoutActed = answer.ok
      ? {
          kind: 'scout-acted',
          requestId: request.requestId,
          ok: true,
          ...(answer.session ? { session: answer.session } : {}),
        }
      : { kind: 'scout-acted', requestId: request.requestId, ok: false, reason: answer.reason.slice(0, 2000) };
    wsSend(reply);
  }

  /**
   * A follow-up for a session this node doesn't hold (it restarted since) rebuilds it from the hub's
   * `resume`, continuing the hub's seq so nothing collides with events already stored. The runtime has
   * no live process, so its first send resumes the conversation with `--resume`.
   */

  /** The session a command names, rebuilt from the hub's `resume` after a restart; undefined after saying why not. */
  function sessionFor({ session, resume }: { session: string; resume?: Resume | undefined }): SessionState | undefined {
    let state = sessions.get(session);
    if (!state && resume) {
      const { cwd, nextSeq, engine, effort, mode } = resume;
      // Resuming on another engine would quietly lose what the Quest was started for (e.g. artifacts).
      if (!runs(engine)) {
        sendNodeError(session, `this node no longer runs the ${engine} engine this session started on`);
        return undefined;
      }
      log(`rebuilding session ${session} in ${cwd} from seq ${nextSeq}`);
      createSession(session, cwd, nextSeq, mode, undefined, engine, effort);
      state = sessions.get(session);
    }
    if (!state) {
      sendNodeError(session, `unknown session: ${session}`);
      return undefined;
    }
    if (state.closed) {
      sendNodeError(session, `session is closed: ${session}`);
      return undefined;
    }
    return state;
  }

  function handleSessionEffort(cmd: Extract<NodeCommand, { type: 'session.effort' }>): void {
    const state = sessionFor(cmd);
    if (!state) return;
    state.runtime.setEffort?.(cmd.effort);
    sendEnvelope(cmd.session, 'session.effort', cmd.effort ? { effort: cmd.effort } : {});
  }

  function handleSessionSend(cmd: Extract<NodeCommand, { type: 'session.send' }>): void {
    const state = sessionFor(cmd);
    if (!state) return;
    const text = withFiles(cmd.session, cmd.text, cmd.attachments);
    if (text === undefined) return;
    // Recorded before the send, so the follow-up sorts ahead of anything the reply emits.
    sendEnvelope(cmd.session, 'user.message', { text });
    state.runtime.send(text);
  }

  /** Sends the hub the current external sessions; unless `force`, only when the list changed. */
  async function reportExternal(force: boolean): Promise<void> {
    if (!transcripts) return;
    let sessions: ExternalSession[];
    try {
      sessions = await transcripts.list();
    } catch (error) {
      log('failed to list external sessions', error);
      return;
    }
    const json = JSON.stringify(sessions);
    if (!force && json === lastExternal) return;
    lastExternal = json;
    wsSend({ kind: 'external', sessions } satisfies NodeExternal);
  }

  /** Sends the hub the node's project folders; unless `force`, only when the list changed. */
  async function reportCli(force: boolean): Promise<void> {
    const version = await options.cliVersion?.();
    if (!version || (!force && version === lastCli)) return;
    lastCli = version;
    wsSend(NodeCli.parse({ kind: 'cli', version }));
  }

  /** Answers what a Quest could use here. A failure says only that it failed: its text can name paths on this machine. */
  async function handleListInventory({ requestId, cwd }: HubListInventory): Promise<void> {
    let events: NodeInventoryListed['events'];
    try {
      events = await options.listInventory?.(cwd);
    } catch {
      events = undefined;
    }
    wsSend(NodeInventoryListed.parse({ kind: 'inventory-listed', requestId, ...(events ? { events } : {}) }));
  }

  /** Runs the CLI's own update when no Quest here is busy, one at a time, and tells the hub how it went. */
  async function handleCliUpdate({ requestId }: HubCliUpdate): Promise<void> {
    const answer = (reply: { ok: boolean; version?: string; reason?: string }) =>
      wsSend(NodeCliUpdated.parse({ kind: 'cli-updated', requestId, ...reply }));
    const { updateCli } = options;
    if (!updateCli) return answer({ ok: false, reason: 'this Kingdom cannot update its CLI' });
    if (updatingCli) return answer({ ok: false, reason: 'an update is already running' });
    const busy = status().busy.length;
    if (busy > 0) {
      return answer({
        ok: false,
        reason: `${busy} ${busy === 1 ? 'Quest is' : 'Quests are'} busy here: try when idle`,
      });
    }
    updatingCli = true;
    try {
      await updateCli();
      const version = await options.cliVersion?.(true);
      if (version) lastCli = version;
      answer({ ok: true, ...(version ? { version } : {}) });
    } catch (error) {
      log('agent CLI update failed', error);
      const reason = error instanceof Error ? error.message : String(error);
      answer({ ok: false, reason: reason.slice(-MAX_CLI_UPDATE_REASON) });
    } finally {
      updatingCli = false;
    }
  }

  async function reportProjects(force: boolean): Promise<void> {
    if (!projects) return;
    let list: Project[];
    try {
      list = await projects();
    } catch (error) {
      log('failed to list projects', error);
      return;
    }
    const json = JSON.stringify(list);
    if (!force && json === lastProjects) return;
    lastProjects = json;
    wsSend({ kind: 'projects', projects: list } satisfies NodeProjects);
  }

  /**
   * Takes over a session the engine ran outside the bridge: registers it, sends `session.started` (marked
   * adopted, so the hub shows it idle) and its history as envelopes. No process starts; the first send resumes
   * the conversation with `--resume` in its original directory.
   */
  async function handleSessionAdopt(cmd: Extract<NodeCommand, { type: 'session.adopt' }>): Promise<void> {
    if (!runs(cmd.engine)) {
      sendNodeError(cmd.session, `this node does not run the ${cmd.engine} engine`);
      return;
    }
    if (sessions.has(cmd.session)) {
      sendNodeError(cmd.session, `session already exists: ${cmd.session}`);
      return;
    }
    const found = await transcripts?.load(cmd.session).catch((error: unknown) => {
      log('failed to load a transcript', error);
      return undefined;
    });
    // Checked again: another adopt for the same id may have finished while this one was reading.
    if (!found || sessions.has(cmd.session)) {
      sendNodeError(
        cmd.session,
        found ? `session already exists: ${cmd.session}` : `no transcript for session ${cmd.session}`,
      );
      return;
    }
    const { summary, events } = found;
    createSession(cmd.session, summary.cwd, 0, undefined, undefined, cmd.engine);
    sendEnvelope(cmd.session, 'session.started', {
      cwd: summary.cwd,
      prompt: summary.title,
      label: labelFromPrompt(summary.title),
      mode: defaultMode,
      adopted: true,
      ...(cmd.engine ? { engine: cmd.engine } : {}),
    });
    for (const event of events) sendEnvelope(cmd.session, event.type, event.payload);
  }

  /**
   * Closes a session for good: stops its process, optionally removes its worktree (never forcing), and records
   * session.closed. A session this node no longer holds (it restarted) is closed from the hub's `resume`.
   */
  async function handleSessionClose(cmd: Extract<NodeCommand, { type: 'session.close' }>): Promise<void> {
    let state = sessions.get(cmd.session);
    if (!state && cmd.resume) {
      state = { seq: cmd.resume.nextSeq, unacked: new Map(), runtime: CLOSED_RUNTIME, cwd: cmd.resume.cwd };
      sessions.set(cmd.session, state);
    }
    if (!state || state.closed) {
      sendNodeError(
        cmd.session,
        state ? `session is already closed: ${cmd.session}` : `unknown session: ${cmd.session}`,
      );
      return;
    }
    state.closed = true;
    denyPending(cmd.session);
    // Each step runs whatever the last one did, and the close is recorded: nothing more can be sent to this Quest.
    try {
      state.runtime.close();
    } catch (error) {
      reportFailure(cmd.session, error);
    }
    try {
      removeAttachments(cmd.session, attachmentsDir);
    } catch (error) {
      reportFailure(cmd.session, error);
    }
    let worktree: { removed: boolean; reason?: string } | undefined;
    if (cmd.removeWorktree && removeWorktree) {
      worktree = await removeWorktree(state.cwd).catch((error: unknown) => ({
        removed: false,
        reason: error instanceof Error ? error.message : String(error),
      }));
    }
    sendEnvelope(cmd.session, 'session.closed', worktree ? { worktree } : {});
  }

  /**
   * A prompt with its files saved and their paths added (the hub only ever sees the text), or undefined after
   * reporting files that couldn't be saved, so nothing goes out without them.
   */
  function withFiles(session: string, text: string, files: readonly Attachment[] | undefined): string | undefined {
    if (!files?.length) return text;
    try {
      return withAttachments(text, saveAttachments(session, files, attachmentsDir));
    } catch (error) {
      sendNodeError(
        session,
        `could not save the attached files: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  function handleSessionInterrupt(cmd: Extract<NodeCommand, { type: 'session.interrupt' }>): void {
    const state = sessions.get(cmd.session);
    if (!state) {
      sendNodeError(cmd.session, `unknown session: ${cmd.session}`);
      return;
    }
    state.runtime.interrupt();
  }

  function handlePermissionAnswer(cmd: Extract<NodeCommand, { type: 'permission.answer' }>): void {
    const pending = pendingPermissions.get(cmd.requestId);
    if (!pending) {
      log(`ignored an answer for an unknown or expired permission request: ${cmd.requestId}`);
      return;
    }
    pendingPermissions.delete(cmd.requestId);
    pending.resolve(cmd.behavior, cmd.message, cmd.answers);
  }

  /** Denies and forgets every pending request for one session, or for all sessions. */
  function denyPending(sessionId?: string): void {
    for (const [requestId, pending] of [...pendingPermissions]) {
      if (sessionId !== undefined && pending.session !== sessionId) continue;
      pendingPermissions.delete(requestId);
      pending.resolve('deny', SESSION_ENDED_MESSAGE);
    }
  }

  /**
   * A throw here must stay with its Quest: from an async handler it would be an unhandled rejection, which ends Crystal
   * and every Quest on it. Starting or sending failed means nothing is running the Quest, so it ends. Anything else
   * failed beside a process that's still going, so that's only reported.
   */
  function handleCommand(cmd: NodeCommand): void {
    try {
      switch (cmd.type) {
        case 'session.start':
          handleSessionStart(cmd).catch((error: unknown) => failSession(cmd.session, error));
          break;
        case 'session.send':
          handleSessionSend(cmd);
          break;
        case 'session.interrupt':
          handleSessionInterrupt(cmd);
          break;
        case 'session.effort':
          handleSessionEffort(cmd);
          break;
        case 'session.keys': {
          const state = sessions.get(cmd.session);
          if (state?.runtime.keys) {
            state.runtime.keys({
              ...(cmd.keys ? { keys: cmd.keys } : {}),
              ...(cmd.retype ? { retype: true } : {}),
            });
          } else sendNodeError(cmd.session, `this session has no terminal to answer: ${cmd.session}`);
          break;
        }
        case 'session.mode': {
          const state = sessionFor(cmd);
          if (state) {
            state.runtime.setMode(cmd.mode);
            sendEnvelope(cmd.session, 'session.mode', { mode: cmd.mode });
          }
          break;
        }
        case 'session.adopt':
          handleSessionAdopt(cmd).catch((error: unknown) => failSession(cmd.session, error));
          break;
        case 'session.close':
          handleSessionClose(cmd).catch((error: unknown) => reportFailure(cmd.session, error));
          break;
        case 'permission.answer':
          handlePermissionAnswer(cmd);
          break;
        case 'file.read':
          handleFileRead(cmd).catch((error: unknown) => log('file read failed', error));
          break;
      }
    } catch (error) {
      if (cmd.type === 'session.send') failSession(cmd.session, error);
      else if ('session' in cmd) reportFailure(cmd.session, error);
      else log('command handler threw', error);
    }
  }

  /**
   * The viewer reads a file in a Quest's folder: the node's own record of the folder for a Quest it holds, otherwise
   * the folder the hub filled in from its store (a Quest idle since a restart). Never a folder a client chose.
   */
  async function handleFileRead(cmd: Extract<NodeCommand, { type: 'file.read' }>): Promise<void> {
    const cwd = sessions.get(cmd.session)?.cwd ?? cmd.cwd;
    let reply: FileReply;
    if (cwd === undefined) {
      reply = { kind: 'file', requestId: cmd.requestId, ok: false, reason: `unknown session: ${cmd.session}` };
    } else {
      try {
        reply = { kind: 'file', requestId: cmd.requestId, ...(await readSessionFile(cwd, cmd.path)) };
      } catch (error) {
        log('file read failed', error);
        reply = { kind: 'file', requestId: cmd.requestId, ok: false, reason: 'could not read the file' };
      }
    }
    wsSend(reply);
  }

  function handleMessage(data: import('ws').RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      log('dropped malformed JSON frame from hub');
      return;
    }

    const ack = HubAck.safeParse(parsed);
    if (ack.success) {
      handleAck(ack.data);
      return;
    }

    const command = NodeCommand.safeParse(parsed);
    if (command.success) {
      handleCommand(command.data);
      return;
    }

    const cliUpdate = HubCliUpdate.safeParse(parsed);
    if (cliUpdate.success) {
      void handleCliUpdate(cliUpdate.data);
      return;
    }

    const listing = HubListInventory.safeParse(parsed);
    if (listing.success) {
      void handleListInventory(listing.data);
      return;
    }

    const runNow = HubScoutRunNow.safeParse(parsed);
    if (runNow.success) {
      options.scouts?.runNow(runNow.data.scout);
      return;
    }

    const action = HubScoutAction.safeParse(parsed);
    if (action.success) {
      void handleScoutAction(action.data);
      return;
    }

    const quest = HubScoutQuest.safeParse(parsed);
    if (quest.success) {
      void handleScoutAction(quest.data);
      return;
    }

    const patrolRunNow = HubPatrolRunNow.safeParse(parsed);
    if (patrolRunNow.success) {
      options.patrols?.runNow(patrolRunNow.data.patrol);
      return;
    }

    // "Patrol this" on a Board: the item's Quest action, drafted as a Patrol for the app's form; nothing starts.
    const patrolDraft = HubPatrolDraft.safeParse(parsed);
    if (patrolDraft.success) {
      const { requestId } = patrolDraft.data;
      let answer: ReturnType<NonNullable<typeof options.scouts>['draft']>;
      try {
        answer = options.scouts
          ? options.scouts.draft(patrolDraft.data)
          : { ok: false, reason: 'this Kingdom runs no Scouts' };
      } catch (error) {
        answer = { ok: false, reason: `the draft failed: ${error instanceof Error ? error.message : String(error)}` };
      }
      wsSend(
        (answer.ok
          ? // The Quest this button starts runs in the Kingdom's default mode when the action names none; so does its Patrol.
            { kind: 'patrol-drafted', requestId, draft: { ...answer.draft, mode: answer.draft.mode ?? defaultMode } }
          : { kind: 'patrol-drafted', requestId, reason: answer.reason.slice(0, 2000) }) satisfies NodePatrolDrafted,
      );
      return;
    }

    const patrolPreview = HubPatrolPreview.safeParse(parsed);
    if (patrolPreview.success) {
      const { requestId, schedule, count } = patrolPreview.data;
      const answer = options.patrols
        ? preview(schedule, count, Date.now())
        : { reason: 'this Kingdom runs no Patrols' };
      wsSend(
        ('times' in answer
          ? { kind: 'patrol-previewed', requestId, times: answer.times }
          : {
              kind: 'patrol-previewed',
              requestId,
              reason: answer.reason.slice(0, 2000),
            }) satisfies NodePatrolPreviewed,
      );
      return;
    }

    const patrolChange = HubPatrolChange.safeParse(parsed);
    if (patrolChange.success) {
      void handlePatrolChange(patrolChange.data);
      return;
    }

    const kingdomVersion = HubKingdomVersion.safeParse(parsed);
    if (kingdomVersion.success) {
      options.onKingdomVersion?.(kingdomVersion.data.version);
      return;
    }

    refuseUnreadable(parsed);
  }

  function scheduleReconnect(): void {
    if (closed || reconnectTimer) return;
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect(): void {
    if (closed) return;
    const ws = new WebSocket(hubUrl, token ? { headers: { authorization: `Bearer ${token}` } } : {});
    socket = ws;
    let accepted: NodeJS.Timeout | undefined;

    ws.on('open', () => {
      log('connected to the hub');
      accepted = setTimeout(() => {
        backoffMs = INITIAL_BACKOFF_MS;
      }, ACCEPTED_AFTER_MS);
      accepted.unref?.();
      keepBeating(ws, options.heartbeatMs, () => log('the hub stopped answering, reconnecting'));
      wsSend(
        NodeHello.parse({
          kind: 'hello',
          node: nodeId,
          protocol: PROTOCOL_VERSION,
          sessions: [...sessions].filter(([, st]) => !st.closed).map(([id]) => id),
          ...(engines ? { engines } : {}),
          ...(options.release ? { release: options.release } : {}),
          ...(options.updateCli ? { cliUpdate: true } : {}),
          ...(options.listInventory ? { inventory: true } : {}),
          ...(options.onKingdomVersion ? { selfUpdate: true } : {}),
          ...(options.scouts ? { scouts: true, scoutQuests: true, patrolDrafts: true } : {}),
          ...(options.patrols ? { patrols: true, patrolsFromApp: options.patrols.fromApp(), patrolPreview: true } : {}),
        }),
      );
      resendUnacked();
      void reportExternal(true);
      void reportProjects(true);
      void reportCli(true);
      if (options.summons) {
        wsSend({ kind: 'summons', summons: options.summons.list() } satisfies NodeSummons);
        for (const cast of options.summons.casts()) wsSend({ kind: 'cast', cast } satisfies NodeCast);
      }
      if (options.scouts) {
        reportScouts(options.scouts.list());
        for (const frame of options.scouts.recent()) wsSend(frame);
      }
      // The list first: the hub keeps runs only for Patrols it has listed.
      if (options.patrols) {
        reportPatrols(options.patrols.list());
        for (const frame of options.patrols.recent()) wsSend(frame);
      }
    });

    ws.on('message', (data) => handleMessage(data));

    ws.on('close', (code, reason) => {
      clearTimeout(accepted);
      if (socket === ws) socket = null;
      // Still retried: updating the hub can end the refusal.
      if (code === CLOSE_WRONG_PROTOCOL || code === CLOSE_DUPLICATE_NODE) {
        log(`the hub refused this node: ${reason.toString()}`);
      }
      scheduleReconnect();
    });

    ws.on('error', (error: Error) => {
      log('hub socket error', error.message);
    });
  }

  function handlePermissionRequest(request: PermissionRequest): Promise<PermissionDecision> {
    // Only a session this node runs can ask. Anything else would send an envelope with a made-up seq (colliding with
    // stored events, or starting a phantom session) and then wait forever for an answer nobody can give.
    const state = sessions.get(request.session);
    if (!state || state.closed) {
      log(`denied a permission request for a session this node does not run: ${request.session}`);
      return Promise.resolve({ behavior: 'deny', message: 'This session is not running on this node.' });
    }
    return new Promise<PermissionDecision>((resolve) => {
      let stopTimer: (() => void) | undefined;
      pendingPermissions.set(request.requestId, {
        session: request.session,
        resolve: (behavior, message, answers) => {
          stopTimer?.();
          // Answers to a question go back inside the tool's own input, which is how the CLI reads them.
          const allow: PermissionDecision = answers
            ? { behavior: 'allow', updatedInput: { ...(request.input as object), answers } }
            : { behavior: 'allow' };
          const decision: PermissionDecision =
            behavior === 'allow' ? allow : { behavior: 'deny', message: message ?? 'Denied by user' };
          resolve(decision);
          sendEnvelope(request.session, 'permission.resolved', { requestId: request.requestId, behavior });
        },
      });

      const payload: Record<string, unknown> = {
        requestId: request.requestId,
        toolName: request.toolName,
        input: request.input,
      };
      if (request.toolUseId !== undefined) payload.toolUseId = request.toolUseId;
      sendEnvelope(request.session, 'permission.request', payload);
      stopTimer = timePatrolPrompt(request.requestId, request.session);
    });
  }

  const scanTimer =
    transcripts || projects
      ? setInterval(() => {
          void reportExternal(false);
          void reportProjects(false);
          void reportCli(false);
        }, options.scanMs ?? DEFAULT_SCAN_MS)
      : null;
  scanTimer?.unref();

  function close(): Promise<void> {
    closed = true;
    if (scanTimer) clearInterval(scanTimer);
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    denyPending();
    // A Patrol's Quest ended by closing hasn't ended its run: the Patrols say so on the next start.
    patrolQuests.clear();
    errandsThisTurn.clear();
    deedsThisTurn.clear();
    turnLoot.clear();
    finishedLoot.clear();
    const stopping: Promise<void>[] = [];
    for (const [id, state] of sessions) {
      // One that won't stop mustn't leave the rest running after Crystal has gone.
      try {
        state.runtime.close();
        if (state.runtime.stopped) stopping.push(state.runtime.stopped());
      } catch (error) {
        log(`could not stop ${id}`, error);
      }
    }
    if (socket) {
      const ws = socket;
      socket = null;
      ws.close();
    }
    let timer: NodeJS.Timeout | undefined;
    const cap = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CLOSE_WAIT_MS);
      timer.unref?.();
    });
    return Promise.race([Promise.all(stopping).then(() => undefined), cap]).finally(() => clearTimeout(timer));
  }

  function status(): NodeStatus {
    const open = [...sessions].filter(([, state]) => !state.closed);
    const busy = open.filter(([, state]) => state.runtime.busy);
    const reasons = Object.fromEntries(
      busy.flatMap(([id, state]) => (state.runtime.busyReason ? [[id, state.runtime.busyReason]] : [])),
    );
    return { node: nodeId, sessions: open.length, busy: busy.map(([id]) => id), reasons };
  }

  connect();

  function reportSelfUpdate({ version, state, reason }: SelfUpdate): void {
    const short = reason?.slice(-MAX_CLI_UPDATE_REASON);
    wsSend(NodeSelfUpdate.parse({ kind: 'self-update', version, state, ...(short ? { reason: short } : {}) }));
  }

  function reportCast(cast: Cast): void {
    wsSend({ kind: 'cast', cast } satisfies NodeCast);
  }

  function reportSummons(summons: Summon[]): void {
    wsSend({ kind: 'summons', summons } satisfies NodeSummons);
  }

  function reportScouts(scouts: Scout[]): void {
    wsSend({ kind: 'scouts', scouts } satisfies NodeScouts);
  }

  function reportScoutRun(scout: string, run: ScoutRun, items: ScoutItem[] | undefined): void {
    wsSend({ kind: 'scout-run', scout, run, ...(items ? { items } : {}) } satisfies NodeScoutRun);
  }

  function reportPatrols(patrols: Patrol[]): void {
    wsSend({ kind: 'patrols', patrols } satisfies NodePatrols);
  }

  function reportPatrolRun(patrol: string, run: PatrolRun): void {
    wsSend({ kind: 'patrol-run', patrol, run } satisfies NodePatrolRun);
  }

  function holds(session: string): boolean {
    const state = sessions.get(session);
    return state !== undefined && !state.closed;
  }

  function titleQuest(session: string, title: QuestTitledPayload): string | undefined {
    if (!holds(session)) return 'This session is not running on this node.';
    sendEnvelope(session, 'quest.titled', title);
    return undefined;
  }

  function leaveErrand(
    session: string,
    errand: { title: string; body: string },
  ): { ok: true; id: string } | { ok: false; reason: string } {
    if (!holds(session)) return { ok: false, reason: 'This session is not running on this node.' };
    const left = errandsThisTurn.get(session) ?? 0;
    if (left >= MAX_ERRANDS_PER_TURN) {
      return {
        ok: false,
        reason: `A Quest may leave at most ${MAX_ERRANDS_PER_TURN} Errands in one turn; say the rest in your reply.`,
      };
    }
    const id = randomUUID();
    sendEnvelope(session, 'errand.left', { id, title: errand.title, body: errand.body });
    errandsThisTurn.set(session, left + 1);
    return { ok: true, id };
  }

  function recordDeed(
    session: string,
    deed: { deed: string; detail?: string },
  ): { ok: true; id: string } | { ok: false; reason: string } {
    if (!holds(session)) return { ok: false, reason: 'This session is not running on this node.' };
    const done = deedsThisTurn.get(session) ?? 0;
    if (done >= MAX_DEEDS_PER_TURN) {
      return {
        ok: false,
        reason: `A Quest may record at most ${MAX_DEEDS_PER_TURN} Deeds in one turn; record only what matters most.`,
      };
    }
    const id = randomUUID();
    sendEnvelope(session, 'deed.recorded', { id, deed: deed.deed, ...(deed.detail ? { detail: deed.detail } : {}) });
    deedsThisTurn.set(session, done + 1);
    return { ok: true, id };
  }

  return {
    handlePermissionRequest,
    status,
    reportSelfUpdate,
    reportCast,
    reportSummons,
    reportScouts,
    reportScoutRun,
    reportPatrols,
    reportPatrolRun,
    startPatrolQuest,
    forgetPatrolQuest(session: string) {
      // Still starting (its worktree being made): remembered, so it isn't watched once it's started.
      if (!patrolQuests.delete(session) && !sessions.has(session)) forgottenQuests.add(session);
    },
    holds,
    titleQuest,
    leaveErrand,
    recordDeed,
    close,
  };
}
