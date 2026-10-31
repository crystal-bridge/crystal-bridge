import { reportChanges, type TurnChanges } from './changes.js';
import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import type { Effort, EventType, PermissionMode, UsagePayload } from '@crystal-bridge/protocol';
import { usageFromRaw } from './usage.js';

/** The subset of protocol event types a running `claude` process can emit on its own. */
export type ClaudeSessionEventType = Extract<
  EventType,
  'claude.event' | 'session.ended' | 'session.resumed' | 'turn.finished' | 'usage' | 'error' | 'terminal.screen'
>;

/** payload for `claude.event`, per `packages/protocol/src/envelope.ts`. */
export interface ClaudeEventPayload {
  engine: 'claude';
  raw: unknown;
}

/**
 * Why a process ended: `idle` when Crystal stopped it after `idleMs` without a send, `error` on a
 * non-zero exit or a failed spawn, `exit` otherwise (including Stop, which exits 0).
 */
export type EndReason = 'idle' | 'exit' | 'error';

/** payload for `session.ended`, per `packages/protocol/src/envelope.ts`. */
export interface SessionEndedPayload {
  exitCode: number | null;
  signal: string | null;
  reason: EndReason;
}

/** payload for `turn.finished`: the CLI's result line in engine-neutral terms. */
export interface TurnFinishedPayload {
  outcome: 'success' | 'error' | 'interrupted';
  /** The start of the reply, for a notification. */
  summary?: string;
  /** This turn's own cost in US dollars (not the session's running total), when the engine reports one. */
  costUsd?: number;
  /** The whole turn, from when it opened: tool time and waiting on approvals included. */
  durationMs?: number;
  /** This turn's tokens, when reported. */
  tokens?: TurnTokens;
}

/** A turn's token counts in engine-neutral names. */
export interface TurnTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** A stream-json usage object as engine-neutral tokens, or undefined when it reports none. */
export function neutralTokens(usage: unknown): TurnTokens | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined;
  const u = usage as Record<string, unknown>;
  const n = (key: string) => (typeof u[key] === 'number' ? (u[key] as number) : 0);
  const tokens = {
    input: n('input_tokens'),
    output: n('output_tokens'),
    cacheRead: n('cache_read_input_tokens'),
    cacheWrite: n('cache_creation_input_tokens'),
  };
  return Object.values(tokens).some((v) => v > 0) ? tokens : undefined;
}

const SUMMARY_CHARS = 140;

/** A stream-json `result` line as a turn outcome; Stop ends a turn with subtype error_during_execution. */
function turnFinished(
  raw: { subtype?: unknown; is_error?: unknown; result?: unknown; duration_ms?: unknown; usage?: unknown },
  costUsd: number | undefined,
): TurnFinishedPayload {
  const stats: Partial<TurnFinishedPayload> = {};
  if (costUsd !== undefined) stats.costUsd = costUsd;
  if (typeof raw.duration_ms === 'number') stats.durationMs = raw.duration_ms;
  const tokens = neutralTokens(raw.usage);
  if (tokens) stats.tokens = tokens;
  if (raw.subtype === 'success' && raw.is_error !== true) {
    const summary = typeof raw.result === 'string' ? raw.result.trim().slice(0, SUMMARY_CHARS) : '';
    return summary ? { outcome: 'success', summary, ...stats } : { outcome: 'success', ...stats };
  }
  return { outcome: raw.subtype === 'error_during_execution' ? 'interrupted' : 'error', ...stats };
}

/** payload for `error`, per `packages/protocol/src/envelope.ts`. */
export interface ErrorPayload {
  message: string;
}

/** An interactive Quest's screen while it needs a person; `raised` marks the first, which calls for attention. */
export interface TerminalScreenPayload {
  open: boolean;
  text?: string;
  raised?: boolean;
  /** A typed message is waiting on this, and can be typed again from the card. */
  held?: boolean;
}

export type ClaudeSessionEvent =
  | { type: 'claude.event'; payload: ClaudeEventPayload }
  | { type: 'session.ended'; payload: SessionEndedPayload }
  | { type: 'session.resumed'; payload: Record<string, never> }
  | { type: 'usage'; payload: UsagePayload }
  | { type: 'turn.finished'; payload: TurnFinishedPayload }
  | { type: 'terminal.screen'; payload: TerminalScreenPayload }
  | { type: 'error'; payload: ErrorPayload };

export interface ClaudeSessionOptions {
  /** Also used as Claude's own `--session-id` / `--resume` argument. */
  session: string;
  cwd: string;
  /** URL of the Task 4 permission server for this session, e.g. `http://127.0.0.1:<port>/mcp/<session>`. */
  permissionUrl: string;
  spawn?: typeof nodeSpawn;
  claudeBin?: string;
  /** The system this runs on (default: this one). */
  platform?: NodeJS.Platform;
  /** Stop the process this long after a `result` with no `send`; defaults to `CRYSTAL_IDLE_MS`, then 10 minutes. */
  idleMs?: number;
  /** `--permission-mode` for every process this session starts; `setMode` changes it. Default: manual. */
  permissionMode?: PermissionMode;
  /** The environment `claude` starts with (default: Crystal's own); `CRYSTAL_SESSION` is added. */
  env?: Record<string, string | undefined>;
  /** Start as a copy of this conversation (`--resume <it> --fork-session`); later processes resume `session`. */
  forkFrom?: string;
  /** Pass `--chrome`, for a node whose user runs Chrome with the Claude extension signed in (CRYSTAL_CHROME=1). */
  chrome?: boolean;
  /** `--effort` for every process this session starts; unset leaves the CLI's default. */
  effort?: Effort;
  /** Folders outside `cwd` the agent may read without asking (`--add-dir`), e.g. its attached files. */
  addDirs?: readonly string[];
  /** Works out what each turn changed; unset, no `system/turn_changes` lines are sent. */
  changes?: TurnChanges;
  /** The size the model's context is held to, when one is configured. */
  compactWindow?: (model: string | undefined) => number | undefined;
}

type ClaudeChild = ChildProcessByStdio<Writable, Readable, Readable>;

/** How long to wait, after ending stdin, before escalating to SIGTERM in close(). */
const CLOSE_GRACE_MS = 5000;
const DEFAULT_IDLE_MS = 10 * 60 * 1000;
/** Stderr is only surfaced on a non-zero exit, and only this many trailing characters of it. */
const STDERR_TAIL_CHARS = 4000;

function buildArgs(
  permissionUrl: string,
  sessionArgs: readonly string[],
  mode: PermissionMode,
  chrome = false,
  effort?: Effort,
  addDirs: readonly string[] = [],
): string[] {
  const mcpConfig = JSON.stringify({ mcpServers: { crystal: { type: 'http', url: permissionUrl } } });
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--mcp-config',
    mcpConfig,
    '--permission-prompt-tool',
    'mcp__crystal__approve',
    '--permission-mode',
    mode,
    ...(chrome ? ['--chrome'] : []),
    ...(effort ? ['--effort', effort] : []),
    // One folder per flag, each followed by another flag: --add-dir takes a list.
    ...addDirs.flatMap((dir) => ['--add-dir', dir]),
    ...sessionArgs,
  ];
}

/** The stdin message shape Task 5 recorded: accepted both as the first message and after a `result`. */
function userMessage(text: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;
}

/** Whether a stream-json line starts work that keeps running after its turn: a Monitor, or a background command or agent. */
function startsBackgroundWork(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const line = raw as { type?: unknown; subtype?: unknown; is_backgrounded?: unknown; message?: { content?: unknown } };
  // A call needn't ask for the background to land there, so what the CLI reports counts too.
  if (line.type === 'system' && line.subtype === 'task_started' && line.is_backgrounded === true) return true;
  if (line.type !== 'assistant' || !Array.isArray(line.message?.content)) return false;
  return line.message.content.some((block: unknown) => {
    if (typeof block !== 'object' || block === null) return false;
    const { type, name, input } = block as { type?: unknown; name?: unknown; input?: { run_in_background?: unknown } };
    return type === 'tool_use' && (name === 'Monitor' || input?.run_in_background === true);
  });
}

function tail(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

/** Everything that belongs to one spawned `claude` process, so a late event from an old one can't touch a newer one. */
interface ChildRecord {
  proc: ClaudeChild;
  stdoutBuffer: string;
  stderrBuffer: string;
  /** 'exit' fired; stdout may still be draining until 'close'. */
  exited: boolean;
  /** 'close' or a spawn 'error' was handled; session.ended has been emitted for this child. */
  ended: boolean;
  closeTimer: NodeJS.Timeout | null;
  /** Runs from a `result` line until the next send; firing stops this child as idle. */
  idleTimer: NodeJS.Timeout | null;
  /** The idle timer fired and stdin was ended; the child is on its way out. */
  idleStopped: boolean;
  /**
   * The process started work that outlives a turn (a Monitor, or a background command or agent). The CLI gives no
   * reliable signal when that work ends, so such a process is never idle-stopped: stopping it would kill the work.
   */
  background: boolean;
}

/**
 * Wraps one `claude -p` stream-json conversation. The first process is started with
 * `--session-id`; if `send` is called after that process has exited, a new one is
 * spawned with `--resume` (the session id is also Claude's own session id, so this
 * continues the same conversation). A `send` that arrives after the process exited but
 * before it closed is queued and delivered to the `--resume` process spawned on 'close'.
 * A process left waiting `idleMs` after a `result` is stopped the same way `close()` stops it,
 * but the session stays usable: the next `send` resumes it.
 * Emits `'event'` with `{ type, payload }` matching the protocol's `claude.event` /
 * `session.ended` / `session.resumed` / `error` shapes.
 */
export class ClaudeSession extends EventEmitter {
  private readonly session: string;
  private readonly cwd: string;
  private readonly permissionUrl: string;
  private readonly spawnFn: typeof nodeSpawn;
  private readonly claudeBin: string;
  private readonly platform: NodeJS.Platform;
  private readonly changes: TurnChanges | undefined;
  private readonly compactWindow: ClaudeSessionOptions['compactWindow'];
  /** The size last announced, so the init line each turn repeats sends it once. */
  private announcedCompact: number | undefined;
  private readonly idleMs: number;
  private readonly env: Record<string, string | undefined>;
  private mode: PermissionMode;
  private readonly forkFrom: string | undefined;
  private readonly chrome: boolean;
  private effort: Effort | undefined;
  /** The effort the live process started with, to tell when a new one is needed. */
  private processEffort: Effort | undefined;
  private readonly addDirs: readonly string[];
  private controlSeq = 0;

  private current: ChildRecord | null = null;
  /** Messages sent while the current child was exiting but not yet closed. */
  private queued: string[] = [];
  private closed = false;
  /** A prompt or follow-up went in and its `result` hasn't come back (waiting on an approval counts). */
  private turnOpen = false;

  /** Mid-turn: restarting Crystal now would cut the turn off. */
  get busy(): boolean {
    const rec = this.current;
    if (rec && rec.background && !rec.ended && !rec.idleStopped) return true;
    return this.turnOpen && rec !== null;
  }

  /** Why `busy` holds, in words for whoever is waiting on it (a deploy). */
  get busyReason(): string | undefined {
    if (!this.busy) return undefined;
    return this.turnOpen ? 'turn open' : 'background tasks running';
  }

  constructor(opts: ClaudeSessionOptions) {
    super();
    this.session = opts.session;
    this.cwd = opts.cwd;
    this.permissionUrl = opts.permissionUrl;
    this.spawnFn = opts.spawn ?? nodeSpawn;
    this.platform = opts.platform ?? process.platform;
    this.claudeBin = opts.claudeBin ?? process.env.CLAUDE_BIN ?? 'claude';
    this.idleMs = opts.idleMs ?? (Number(process.env.CRYSTAL_IDLE_MS) || DEFAULT_IDLE_MS);
    // Hooks can check CRYSTAL_SESSION to tell they run headless under the bridge, e.g. to skip terminal bells.
    this.env = { ...(opts.env ?? process.env), CRYSTAL_SESSION: this.session };
    this.mode = opts.permissionMode ?? 'manual';
    this.forkFrom = opts.forkFrom;
    this.chrome = opts.chrome ?? false;
    this.effort = opts.effort;
    this.addDirs = opts.addDirs ?? [];
    this.changes = opts.changes;
    this.compactWindow = opts.compactWindow;
  }

  /** Spawns the first `claude` process (with `--session-id`) and sends the opening prompt. */
  start(prompt: string): void {
    const rec = this.spawnChild(false);
    this.writeTo(rec, prompt);
  }

  /**
   * Sends a message on the live process. If that process has exited but not closed yet, the
   * message waits for its 'close' and goes to the `--resume` process spawned then. With no
   * process at all, a fresh one is spawned with `--resume`.
   */
  send(text: string): void {
    const rec = this.current;
    if (rec && !rec.ended) {
      this.clearIdleTimer(rec);
      // A new effort needs a new process, which is only safe between turns with nothing running in the background.
      if (this.effort !== this.processEffort && !this.turnOpen && !rec.background && this.isLive(rec)) {
        rec.idleStopped = true;
        this.endChild(rec);
      }
      // An idle-stopped child has had its stdin ended; the text waits for the --resume process.
      if (rec.idleStopped || this.hasExited(rec)) {
        this.queued.push(text);
        this.openTurn();
      } else {
        this.writeTo(rec, text);
      }
      return;
    }
    const fresh = this.spawnChild(true);
    this.writeTo(fresh, text);
  }

  /**
   * Changes the permission mode: a live process switches at once through the CLI's `set_permission_mode` control
   * request, and every later process starts in it.
   */
  setMode(mode: PermissionMode): void {
    this.mode = mode;
    const rec = this.current;
    if (!rec || rec.ended || rec.idleStopped || this.hasExited(rec)) return;
    const request = { subtype: 'set_permission_mode', mode };
    this.control(rec, 'mode', request);
  }

  /** Changes the effort for later processes; `send` moves to one when it can. A running process can't change. */
  setEffort(effort: Effort | undefined): void {
    this.effort = effort;
  }

  private control(rec: ChildRecord, kind: string, request: Record<string, unknown>): void {
    rec.proc.stdin.write(
      `${JSON.stringify({ type: 'control_request', request_id: `${kind}-${++this.controlSeq}`, request })}\n`,
    );
  }

  interrupt(): void {
    const rec = this.current;
    if (!rec || rec.ended) return;
    // Windows has no signals: `kill` would end the process on the spot, without the result that closes the turn.
    if (this.platform === 'win32') this.control(rec, 'stop', { subtype: 'interrupt' });
    else rec.proc.kill('SIGINT');
  }

  private stopWaiters: Array<() => void> = [];
  /** The CLI's running cost at the last result. It carries across `--resume`, so a turn's own is the change. */
  private lastTotalCost = 0;

  /** Resolves once the current process has exited; at once when none is running. */
  stopped(): Promise<void> {
    if (!this.current || this.current.ended) return Promise.resolve();
    return new Promise((resolve) => this.stopWaiters.push(resolve));
  }

  /** Ends stdin so the CLI can finish up, then escalates to SIGTERM after 5s if it is still running. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queued = [];

    const rec = this.current;
    if (!rec || rec.ended) return;
    this.clearIdleTimer(rec);
    if (!rec.closeTimer) this.endChild(rec);
  }

  /** Ends stdin so the CLI can finish up, then SIGTERM after the grace period if it's still running. */
  private endChild(rec: ChildRecord): void {
    const child = rec.proc;
    child.stdin.end();
    rec.closeTimer = setTimeout(() => {
      rec.closeTimer = null;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
      }
    }, CLOSE_GRACE_MS);
  }

  private startIdleTimer(rec: ChildRecord): void {
    this.clearIdleTimer(rec);
    if (rec.background) return;
    rec.idleTimer = setTimeout(() => {
      rec.idleTimer = null;
      if (!this.isLive(rec) || rec.closeTimer) return;
      rec.idleStopped = true;
      this.endChild(rec);
    }, this.idleMs);
  }

  private clearIdleTimer(rec: ChildRecord): void {
    if (rec.idleTimer) {
      clearTimeout(rec.idleTimer);
      rec.idleTimer = null;
    }
  }

  private hasExited(rec: ChildRecord): boolean {
    return rec.exited || rec.proc.exitCode !== null || rec.proc.signalCode !== null;
  }

  private openTurn(): void {
    if (!this.turnOpen) void this.changes?.begin();
    this.turnOpen = true;
  }

  private writeTo(rec: ChildRecord, text: string): void {
    this.openTurn();
    rec.proc.stdin.write(userMessage(text));
  }

  private spawnChild(resume: boolean): ChildRecord {
    let sessionArgs = resume ? ['--resume', this.session] : ['--session-id', this.session];
    if (!resume && this.forkFrom) sessionArgs = ['--resume', this.forkFrom, '--fork-session', ...sessionArgs];
    this.processEffort = this.effort;
    const args = buildArgs(this.permissionUrl, sessionArgs, this.mode, this.chrome, this.effort, this.addDirs);

    const child = this.spawnFn(this.claudeBin, args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const rec: ChildRecord = {
      proc: child,
      stdoutBuffer: '',
      stderrBuffer: '',
      exited: false,
      ended: false,
      closeTimer: null,
      idleTimer: null,
      idleStopped: false,
      background: false,
    };
    this.current = rec;
    if (resume) this.emitEvent({ type: 'session.resumed', payload: {} });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.handleStdout(rec, chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      rec.stderrBuffer += chunk;
    });

    child.on('exit', () => {
      rec.exited = true;
    });

    // Without a handler, an ENOENT-style spawn failure (e.g. `claude` not on PATH) would
    // throw as an unhandled 'error' event and crash the whole process.
    child.on('error', (err: Error) => this.handleSpawnError(rec, err));
    // 'close' (not 'exit'): 'exit' can fire before stdout has finished draining, which would
    // let a buffered final `result` line race session.ended.
    child.on('close', (code, signal) => this.handleClose(rec, code, signal));

    // Writing to a process that has already died raises EPIPE; without a handler this is
    // an unhandled 'error' on the stream and crashes the whole process.
    child.stdin.on('error', (err: Error) => this.handleStdinError(rec, err));

    return rec;
  }

  /** True if events from this child should still be acted on. */
  private isLive(rec: ChildRecord): boolean {
    return rec === this.current && !rec.ended;
  }

  private handleStdout(rec: ChildRecord, chunk: string): void {
    if (!this.isLive(rec)) return;
    rec.stdoutBuffer += chunk;
    let newline = rec.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = rec.stdoutBuffer.slice(0, newline);
      rec.stdoutBuffer = rec.stdoutBuffer.slice(newline + 1);
      this.handleLine(rec, line);
      newline = rec.stdoutBuffer.indexOf('\n');
    }
  }

  private handleLine(rec: ChildRecord, line: string): void {
    if (!line.trim()) return;

    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.emitEvent({ type: 'error', payload: { message: line } });
      return;
    }
    this.emitEvent({ type: 'claude.event', payload: { engine: 'claude', raw } });
    if (startsBackgroundWork(raw)) rec.background = true;
    const init = raw as { type?: unknown; subtype?: unknown; model?: unknown };
    if (init?.type === 'system' && init.subtype === 'init' && typeof init.model === 'string') {
      const compactWindow = this.compactWindow?.(init.model);
      if (compactWindow !== undefined && compactWindow !== this.announcedCompact) {
        this.announcedCompact = compactWindow;
        this.emitEvent({
          type: 'claude.event',
          payload: { engine: 'claude', raw: { type: 'system', subtype: 'context_window', compactWindow } },
        });
      }
    }
    const usage = usageFromRaw(raw);
    if (usage) this.emitEvent({ type: 'usage', payload: usage });
    // A finished turn: the process now waits on stdin, so start counting toward an idle stop.
    if (typeof raw === 'object' && raw !== null && (raw as { type?: unknown }).type === 'result') {
      this.turnOpen = false;
      const total = (raw as { total_cost_usd?: unknown }).total_cost_usd;
      let cost: number | undefined;
      if (typeof total === 'number') {
        cost = total >= this.lastTotalCost ? total - this.lastTotalCost : total;
        this.lastTotalCost = total;
      }
      this.emitEvent({ type: 'turn.finished', payload: turnFinished(raw as Record<string, unknown>, cost) });
      reportChanges(this.changes, (payload) => this.emitEvent({ type: 'claude.event', payload }));
      this.startIdleTimer(rec);
    }
  }

  private handleClose(rec: ChildRecord, code: number | null, signal: NodeJS.Signals | null): void {
    if (!this.isLive(rec)) return;

    // A final line with no trailing newline yet (e.g. the process died mid-write) is still
    // a real line; flush it as a claude.event before the terminal session.ended.
    const trailing = rec.stdoutBuffer;
    rec.stdoutBuffer = '';
    this.handleLine(rec, trailing);

    const failed = code !== null && code !== 0;
    // An idle stop ends stdin on purpose; however claude exits after that, it isn't an error.
    if (failed && !rec.idleStopped) {
      const message = tail(rec.stderrBuffer, STDERR_TAIL_CHARS).trim() || `claude exited with code ${code}`;
      this.emitEvent({ type: 'error', payload: { message } });
    }
    this.finishChild(rec, code, signal, rec.idleStopped ? 'idle' : failed ? 'error' : 'exit');
  }

  /** `claude` itself never started (e.g. ENOENT): there is no exit code or signal. */
  private handleSpawnError(rec: ChildRecord, err: Error): void {
    if (!this.isLive(rec)) return;

    // Node reports a missing cwd as `spawn <bin> ENOENT`, which reads like `claude` isn't installed.
    // It's the likelier cause on a resume, after the repo was moved or deleted.
    const reason = existsSync(this.cwd) ? err.message : `working directory not found: ${this.cwd}`;
    this.emitEvent({ type: 'error', payload: { message: `failed to start claude: ${reason}` } });
    this.finishChild(rec, null, null, 'error');
  }

  private handleStdinError(rec: ChildRecord, err: Error): void {
    if (!this.isLive(rec)) return;
    this.emitEvent({ type: 'error', payload: { message: `failed to write to claude: ${err.message}` } });
  }

  /**
   * Marks the current child as ended exactly once, clearing it so a later `send` can respawn.
   * Messages queued while it was closing go to a fresh `--resume` process.
   */
  private finishChild(rec: ChildRecord, code: number | null, signal: NodeJS.Signals | null, reason: EndReason): void {
    rec.ended = true;
    this.clearIdleTimer(rec);
    if (rec.closeTimer) {
      clearTimeout(rec.closeTimer);
      rec.closeTimer = null;
    }
    this.current = null;
    this.turnOpen = false;
    this.emitEvent({ type: 'session.ended', payload: { exitCode: code, signal, reason } });
    for (const resolve of this.stopWaiters.splice(0)) resolve();

    const queued = this.queued;
    this.queued = [];
    if (queued.length === 0 || this.closed) return;
    const fresh = this.spawnChild(true);
    for (const text of queued) this.writeTo(fresh, text);
  }

  private emitEvent(event: ClaudeSessionEvent): void {
    this.emit('event', event);
  }
}
