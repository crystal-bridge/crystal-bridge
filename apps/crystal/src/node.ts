import {
  HubAck,
  HubCliUpdate,
  HubKingdomVersion,
  MAX_CLI_UPDATE_REASON,
  NodeCliUpdated,
  NodeCommand,
  NodeHello,
  NodeSelfUpdate,
  PROTOCOL_VERSION,
  type Attachment,
  type Effort,
  type Envelope,
  type EventType,
  type NodeError,
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
} from '@crystal-bridge/protocol';
import { ATTACHMENTS_DIR, attachmentDir, removeAttachments, saveAttachments, withAttachments } from './attachments.js';
import { WebSocket } from 'ws';
import { readSessionFile } from './files.js';
import type { PermissionDecision, PermissionRequest } from './permissions.js';
import type { ReplayEvent } from './transcripts.js';
import type { ClaudeSessionEvent } from './session.js';

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
  /** How often to rescan `transcripts`; the hub only hears about a change. Default 60 s. */
  scanMs?: number;
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
  /** Whether a session is open here, so only a real Quest can use the `summon` tool. */
  holds(session: string): boolean;
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

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

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

/** The deny message for a prompt whose `claude` process (or the whole node) went away first. */
const SESSION_ENDED_MESSAGE = 'Session ended before an answer';

/** First 60 chars of the prompt's first line, for the session list in the client. */
function labelFromPrompt(prompt: string): string {
  const firstLine = prompt.split('\n', 1)[0] ?? '';
  return firstLine.slice(0, 60);
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

  function sendEnvelope(sessionId: string, type: EventType, payload: unknown): void {
    const state = sessions.get(sessionId);
    const seq = state ? state.seq++ : 0;
    const envelope: Envelope = { node: nodeId, session: sessionId, seq, ts: Date.now(), type, payload };
    if (state) state.unacked.set(seq, envelope);
    wsSend(envelope);
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
      sendEnvelope(sessionId, event.type, event.payload);
    });
    return runtime;
  }

  async function handleSessionStart(cmd: Extract<NodeCommand, { type: 'session.start' }>): Promise<void> {
    // A second start would spawn another claude for the same conversation and restart seq at 0.
    if (sessions.has(cmd.session)) {
      log(`ignored session.start for a session that already exists: ${cmd.session}`);
      sendNodeError(cmd.session, `session already exists: ${cmd.session}`);
      return;
    }

    if (cmd.forkFrom && cmd.worktree) {
      sendNodeError(cmd.session, 'a fork runs in its source session’s folder, not a new worktree');
      return;
    }

    if (!runs(cmd.engine)) {
      sendNodeError(cmd.session, `this node does not run the ${cmd.engine} engine`);
      return;
    }

    let cwd = cmd.cwd;
    let worktree: { root: string; branch: string } | undefined;
    if (cmd.worktree) {
      if (!worktrees) {
        sendNodeError(cmd.session, 'this node cannot create worktrees');
        return;
      }
      try {
        const made = await worktrees(cmd.cwd, cmd.session);
        cwd = made.path;
        worktree = { root: made.root, branch: made.branch };
      } catch (error) {
        sendNodeError(
          cmd.session,
          `could not create a worktree: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      // Checked again: the same start may have arrived twice while the worktree was being made.
      if (sessions.has(cmd.session)) return;
    }

    // Saved first: if they can't be, nothing starts.
    const prompt = withFiles(cmd.session, cmd.prompt, cmd.attachments);
    if (prompt === undefined) return;
    const runtime = createSession(cmd.session, cwd, 0, cmd.mode, cmd.forkFrom, cmd.engine, cmd.effort);
    sendEnvelope(cmd.session, 'session.started', {
      cwd,
      prompt,
      label: labelFromPrompt(cmd.prompt),
      ...(worktree ? { worktree } : {}),
      ...(cmd.forkFrom ? { forkedFrom: cmd.forkFrom } : {}),
      ...(cmd.engine ? { engine: cmd.engine } : {}),
      ...(cmd.effort ? { effort: cmd.effort } : {}),
    });

    runtime.start(prompt);
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
      const { cwd, nextSeq, engine, effort } = resume;
      // Resuming on another engine would quietly lose what the Quest was started for (e.g. artifacts).
      if (!runs(engine)) {
        sendNodeError(session, `this node no longer runs the ${engine} engine this session started on`);
        return undefined;
      }
      log(`rebuilding session ${session} in ${cwd} from seq ${nextSeq}`);
      createSession(session, cwd, nextSeq, undefined, undefined, engine, effort);
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
    state.runtime.close();
    removeAttachments(cmd.session, attachmentsDir);
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

  function handleCommand(cmd: NodeCommand): void {
    try {
      switch (cmd.type) {
        case 'session.start':
          void handleSessionStart(cmd);
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
          const state = sessions.get(cmd.session);
          if (state) state.runtime.setMode(cmd.mode);
          else sendNodeError(cmd.session, `unknown session: ${cmd.session}`);
          break;
        }
        case 'session.adopt':
          void handleSessionAdopt(cmd);
          break;
        case 'session.close':
          void handleSessionClose(cmd);
          break;
        case 'permission.answer':
          handlePermissionAnswer(cmd);
          break;
        case 'file.read':
          void handleFileRead(cmd);
          break;
      }
    } catch (error) {
      log('command handler threw', error);
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

    const kingdomVersion = HubKingdomVersion.safeParse(parsed);
    if (kingdomVersion.success) {
      options.onKingdomVersion?.(kingdomVersion.data.version);
      return;
    }

    log('dropped unrecognized frame from hub', parsed);
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

    ws.on('open', () => {
      backoffMs = INITIAL_BACKOFF_MS;
      wsSend(
        NodeHello.parse({
          kind: 'hello',
          node: nodeId,
          protocol: PROTOCOL_VERSION,
          sessions: [...sessions].filter(([, st]) => !st.closed).map(([id]) => id),
          ...(engines ? { engines } : {}),
          ...(options.release ? { release: options.release } : {}),
          ...(options.updateCli ? { cliUpdate: true } : {}),
          ...(options.onKingdomVersion ? { selfUpdate: true } : {}),
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
    });

    ws.on('message', (data) => handleMessage(data));

    ws.on('close', (code, reason) => {
      if (socket === ws) socket = null;
      // Still retried: updating the hub can end the refusal.
      if (code === CLOSE_WRONG_PROTOCOL) log(`the hub refused this node: ${reason.toString()}`);
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
      pendingPermissions.set(request.requestId, {
        session: request.session,
        resolve: (behavior, message, answers) => {
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
    const stopping: Promise<void>[] = [];
    for (const state of sessions.values()) {
      state.runtime.close();
      if (state.runtime.stopped) stopping.push(state.runtime.stopped());
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

  function holds(session: string): boolean {
    const state = sessions.get(session);
    return state !== undefined && !state.closed;
  }

  return { handlePermissionRequest, status, reportSelfUpdate, reportCast, holds, close };
}
