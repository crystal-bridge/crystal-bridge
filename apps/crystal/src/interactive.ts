import { reportChanges, type TurnChanges } from './changes.js';
import { EventEmitter } from 'node:events';
import { DROP } from './login-env.js';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn as nodePtySpawn } from '@lydell/node-pty';
import headless from '@xterm/headless';
import type { Effort, PermissionMode } from '@crystal-bridge/protocol';
import { mcpConfig } from './permissions.js';
import { type ClaudeSessionEvent, neutralTokens } from './session.js';
import {
  applyListing,
  emptyListing,
  isConversationLine,
  listingFields,
  liveTranscriptEvent,
  type SessionListing,
} from './transcripts.js';
import { usageFromStatusLine } from './usage.js';

/**
 * The `interactive` engine: the real, unmodified interactive `claude` in a pseudo-terminal, under the machine's own
 * login, for the tools only an interactive session gets (artifacts above all). The screen is mirrored but only read
 * for the one-time workspace-trust dialog, and passed to the app when a dialog needs a person.
 * Structure comes from documented hooks (code.claude.com/docs/en/hooks), which
 * Crystal adds through a generated `--settings` file and which POST to Crystal's local server:
 * - PermissionRequest: approvals and questions, answered from the client like the stream engine's (permissions.ts);
 * - SessionStart: the input box is ready, and where the transcript is;
 * - Stop: the turn ended, with the reply's text and any background tasks still running;
 * - Notification: a dialog only the terminal shows.
 * A statusline command (code.claude.com/docs/en/statusline) posts the same way and carries cost, the
 * context window and plan limits, which become the turn result's fields and `usage` events, as on the stream engine.
 * Replies, token counts and the skills and tools listing come from the session's transcript, which the CLI
 * documents as an internal format: `transcripts.ts` keeps that mapping in one place (checked against 2.1.312).
 */

export interface PtyLike {
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  kill(signal?: string): void;
}

export type PtySpawn = (
  file: string,
  args: string[],
  options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
) => PtyLike;

const defaultSpawn: PtySpawn = (file, args, options) => nodePtySpawn(file, args, options);

const isObj = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type HookListener = (event: string, body: Record<string, unknown>) => void;

/** Routes hook calls arriving at Crystal's local server to the session they belong to. */
export class HookBus {
  private readonly listeners = new Map<string, HookListener>();

  register(session: string, listener: HookListener): void {
    this.listeners.set(session, listener);
  }

  unregister(session: string): void {
    this.listeners.delete(session);
  }

  dispatch(session: string, event: string, body: Record<string, unknown>): void {
    this.listeners.get(session)?.(event, body);
  }
}

export interface InteractiveSessionOptions {
  session: string;
  cwd: string;
  /** Crystal's MCP server for this session, which offers the `summon` tool. */
  permissionUrl?: string;
  /** Where hooks POST, without the event name: `http://127.0.0.1:<port>/hook/<session>`. */
  hookUrl: string;
  hooks: HookBus;
  permissionMode?: PermissionMode;
  env?: Record<string, string | undefined>;
  chrome?: boolean;
  /** `--effort` for every process this session starts; unset leaves the CLI's default. */
  effort?: Effort;
  /** Folders outside `cwd` the agent may read without asking (`--add-dir`), e.g. its attached files. */
  addDirs?: readonly string[];
  forkFrom?: string;
  claudeBin?: string;
  /** Where the generated settings file goes; default `<tmp>/crystal-bridge`. */
  settingsDir?: string;
  spawnPty?: PtySpawn;
  /** How often the transcript is read for new lines. */
  pollMs?: number;
  /** Pause after SessionStart before typing, so the input box is drawn. */
  readyDelayMs?: number;
  closeGraceMs?: number;
  /** How long a Stop waits for its reply to reach the transcript before the turn ends anyway. */
  stopWaitMs?: number;
  /** How long after the reply to wait for a statusline carrying the last request's cost. */
  costSettleMs?: number;
  /** Works out what each turn changed; unset, no `system/turn_changes` lines are sent. */
  changes?: TurnChanges;
  /** The size the model's context is held to, when one is configured. */
  compactWindow?: (model: string | undefined) => number | undefined;
  /** How long a prompt typed into an idle terminal may go unsubmitted before something is done about it. */
  submitWaitMs?: number;
  /** How long a process may take to reach its input box before the terminal is shown. */
  startWaitMs?: number;
  /** How long a shown terminal waits for keys before the turn ends as stuck. */
  terminalWaitMs?: number;
  /** The most often a shown terminal's screen is sent. */
  screenUpdateMs?: number;
  /** Pause after Esc dismisses a dialog, before typing the message again. */
  dialogSettleMs?: number;
}

/** Hook events Crystal listens to; PermissionRequest waits on a human, so its timeout is a day. */
const HOOK_EVENTS: Record<string, number> = {
  PermissionRequest: 86_400,
  SessionStart: 30,
  Stop: 30,
  Notification: 30,
  UserPromptSubmit: 30,
};
/** Hook commands whose dialogs the bridge can't answer: say so instead of leaving the Quest silently stuck. */
const TERMINAL_ONLY = new Set(['permission_prompt', 'elicitation_dialog']);
const SUMMARY_CHARS = 140;
const TRUST_ACCEPT_DELAY_MS = 300;
const START_WAIT_MS = 45_000;
const TERMINAL_WAIT_MS = 600_000;
const SCREEN_UPDATE_MS = 1000;
const COLS = 120;
const ROWS = 40;
/** How many of the screen's last non-empty lines an error quotes. */
const SHOWN_LINES = 8;

type Screen = InstanceType<typeof headless.Terminal>;

/** A parent session's variables, the same ones the standard engine drops (login-env.ts). */
const PARENT_SESSION_VARS = new Set([...DROP].filter((key) => key.startsWith('CLAUDE')));

/** The session's environment: the node's, minus a parent session's variables and Crystal's own (its token above all). */
function childEnv(base: Record<string, string | undefined>, session: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (PARENT_SESSION_VARS.has(key)) continue;
    if (key.startsWith('CRYSTAL_')) continue;
    env[key] = value;
  }
  return { ...env, CRYSTAL_SESSION: session, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
}

/** Escape sequences and whitespace removed, to spot a dialog's words however the screen was drawn. */
function screenWords(data: string): string {
  return data
    .replace(/\x1b\[[0-9;?<>=]*[a-zA-Z~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\s+/g, '');
}

/** The joined text blocks of an assistant line, or undefined for anything else. */
function replyText(raw: unknown): string | undefined {
  const line = raw as { type?: unknown; message?: { content?: unknown } };
  if (line?.type !== 'assistant' || !Array.isArray(line.message?.content)) return undefined;
  const texts = line.message.content.flatMap((block: unknown) => {
    const b = block as { type?: unknown; text?: unknown };
    return b?.type === 'text' && typeof b.text === 'string' ? [b.text] : [];
  });
  return texts.length > 0 ? texts.join('') : undefined;
}

function paste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}

/** Reads lines appended to a file since an offset; a torn last line waits for the next read. */
class TranscriptTail {
  private offset: number;
  private partial = '';
  private fd: number | undefined;

  constructor(
    private readonly file: string,
    fromEnd: boolean,
  ) {
    this.fd = existsSync(file) ? openSync(file, 'r') : undefined;
    this.offset = fromEnd && this.fd !== undefined ? fstatSync(this.fd).size : 0;
  }

  read(): unknown[] {
    if (this.fd === undefined) {
      if (!existsSync(this.file)) return [];
      this.fd = openSync(this.file, 'r');
    }
    const size = fstatSync(this.fd).size;
    if (size <= this.offset) return [];
    const buffer = Buffer.alloc(size - this.offset);
    readSync(this.fd, buffer, 0, buffer.length, this.offset);
    this.offset = size;
    const text = this.partial + buffer.toString('utf8');
    const lines = text.split('\n');
    this.partial = lines.pop() ?? '';
    const parsed: unknown[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        parsed.push(JSON.parse(line));
      } catch {
        // A format change: skip the line.
      }
    }
    return parsed;
  }

  close(): void {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
  }
}

/** Background-task statuses that mean the work is over; anything else (running, pending, unknown) counts as live. */
const FINISHED = new Set(['completed', 'complete', 'done', 'failed', 'killed', 'stopped', 'cancelled', 'canceled']);

function field(task: unknown, key: string): string | undefined {
  const value = typeof task === 'object' && task !== null ? (task as Record<string, unknown>)[key] : undefined;
  return typeof value === 'string' ? value : undefined;
}

function isFinished(task: unknown): boolean {
  const status = field(task, 'status');
  return status !== undefined && FINISHED.has(status.toLowerCase());
}

export class InteractiveSession extends EventEmitter {
  private readonly opts: InteractiveSessionOptions;
  private readonly spawnPty: PtySpawn;
  private readonly settingsFile: string;
  private mode: PermissionMode;
  private effort: Effort | undefined;
  /** The effort the live process started with, to tell when a new one is needed. */
  private processEffort: Effort | undefined;
  private pty: PtyLike | null = null;
  private stopWaiters: Array<() => void> = [];

  /** Resolves once the claude process has exited; at once when none is running. */
  stopped(): Promise<void> {
    if (!this.pty) return Promise.resolve();
    return new Promise((resolve) => this.stopWaiters.push(resolve));
  }
  private ready = false;
  private pending: string[] = [];
  private tail: TranscriptTail | null = null;
  private poll: NodeJS.Timeout | null = null;
  private resumed = false;
  private turnOpen = false;
  /** When the open turn began. */
  private turnSince = 0;
  private background = false;
  private closing = false;
  private trustAnswered = false;
  private screen = '';
  /** A mirror of the terminal, rendered, for saying what it showed. */
  private term: Screen | null = null;
  /** A transcript exists to `--resume`: this process resumed one or the CLI has submitted a prompt. */
  private hasConversation = false;
  /** The message typed into an idle terminal, until the CLI submits it. */
  private awaiting: string | null = null;
  /** The awaited message already had its one Esc, for a dialog that offered it. */
  private escaped = false;
  /** The awaited message already had its one restart. */
  private retried = false;
  /** Set while the terminal is being restarted to type this message again. */
  private restartWith: string | null = null;
  private cost: number | undefined;
  /** The running cost when the turn began, so its turn.finished carries the turn's own share. */
  private costAtTurnStart: number | undefined;
  private contextWindow: number | undefined;
  private contextModel: string | undefined;
  private lastUsage = '';
  /** This turn's tokens, summed once per message: a message is written as one line per content block. */
  private turnTokens = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  private countedMessages = new Set<string>();
  private listing: SessionListing = emptyListing();
  private lastListing = '';
  /** The init line's own fields (from SessionStart), re-sent with the listing whenever that changes. */
  private initBase: Record<string, unknown> | undefined;
  /** The text of the latest assistant text block this turn, to tell when Stop's reply has been written. */
  private lastText = '';
  private stopping: { reply: string; timer: NodeJS.Timeout; settling?: boolean } | null = null;
  /** Armed when a prompt is typed into an idle terminal; UserPromptSubmit disarms it. */
  private submitTimer: NodeJS.Timeout | null = null;
  /** Armed when a process starts; reaching the input box disarms it. */
  private startTimer: NodeJS.Timeout | null = null;
  /** The app is showing this terminal, because something on it needs a person. */
  private asking = false;
  private lastShown = '';
  private screenTimer: NodeJS.Timeout | null = null;
  /** Gives up on a shown terminal nobody answers. */
  private askTimer: NodeJS.Timeout | null = null;

  constructor(opts: InteractiveSessionOptions) {
    super();
    this.opts = opts;
    this.spawnPty = opts.spawnPty ?? defaultSpawn;
    this.mode = opts.permissionMode ?? 'manual';
    this.effort = opts.effort;
    const dir = opts.settingsDir ?? join(tmpdir(), 'crystal-bridge');
    mkdirSync(dir, { recursive: true });
    this.settingsFile = join(dir, `${opts.session}.settings.json`);
    opts.hooks.register(opts.session, (event, body) => this.onHook(event, body));
  }

  /** Mid-turn (including waiting on an approval), or holding background tasks the Stop hook reported. */
  get busy(): boolean {
    return this.pty !== null && (this.turnOpen || this.background);
  }

  /** Why `busy` holds, in words for whoever is waiting on it (a deploy). */
  get busyReason(): string | undefined {
    if (!this.busy) return undefined;
    if (this.asking) return 'its terminal is asking something';
    if (!this.turnOpen) return 'background tasks running';
    const secs = Math.floor((Date.now() - this.turnSince) / 1000);
    const took = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m`;
    return this.awaiting !== null ? `typed message not yet taken for ${took}` : `turn open for ${took}`;
  }

  start(prompt: string): void {
    this.spawn(false);
    this.turnOpen = true;
    this.turnSince = Date.now();
    void this.opts.changes?.begin();
    this.pending.push(prompt);
  }

  send(text: string): void {
    const idle = !this.turnOpen;
    if (idle) {
      this.turnSince = Date.now();
      void this.opts.changes?.begin();
    }
    this.turnOpen = true;
    if (!this.pty) {
      this.spawn(true);
      this.emitEvent({ type: 'session.resumed', payload: {} });
      this.pending.push(text);
      return;
    }
    // A new effort needs a new process, which is only safe between turns with nothing running in the background.
    if (idle && this.ready && this.effort !== this.processEffort && !this.background && this.hasConversation) {
      this.restartWith = text;
      this.pty.kill('SIGTERM');
      return;
    }
    if (this.ready) {
      this.type(text);
      // Typed mid-turn, the CLI queues a prompt and submits it later; only an idle terminal should take it at once.
      if (idle) {
        this.awaiting = text;
        this.escaped = false;
        this.retried = false;
        this.watchSubmit();
      }
    } else this.pending.push(text);
  }

  /** Keys for a shown terminal, or the held message typed again. Only while it's shown: otherwise that's `send`. */
  keys({ keys, retype }: { keys?: string; retype?: boolean }): void {
    if (!this.asking || !this.pty) {
      this.emitEvent({ type: 'error', payload: { message: "This Quest's terminal isn't asking anything now." } });
      return;
    }
    if (keys) this.pty.write(keys);
    if (retype && this.awaiting !== null) this.type(this.awaiting);
    this.armAskTimer();
    this.showScreen();
  }

  interrupt(): void {
    if (!this.pty) return;
    this.clearSubmitWatch();
    this.closeTerminal();
    this.pty.write('\x1b');
    if (this.stopping) {
      this.finishTurn();
      return;
    }
    if (this.turnOpen) {
      this.turnOpen = false;
      const durationMs = Date.now() - this.turnSince;
      this.emitEvent({
        type: 'claude.event',
        payload: {
          engine: 'claude',
          raw: { type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: durationMs },
        },
      });
      this.emitEvent({ type: 'turn.finished', payload: { outcome: 'interrupted', durationMs } });
      reportChanges(this.opts.changes, (payload) => this.emitEvent({ type: 'claude.event', payload }));
    }
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
    this.emitEvent({
      type: 'error',
      payload: { message: 'The interactive engine changes mode when this Quest next starts, not mid-session (yet).' },
    });
  }

  /** Changes the effort for later processes; `send` moves to one when it can. A running process can't change. */
  setEffort(effort: Effort | undefined): void {
    this.effort = effort;
  }

  close(): void {
    this.closing = true;
    const pty = this.pty;
    if (!pty) {
      this.opts.hooks.unregister(this.opts.session);
      return;
    }
    if (this.turnOpen) pty.write('\x1b');
    pty.write(`${paste('/exit')}\r`);
    setTimeout(() => {
      if (this.pty === pty) pty.kill('SIGTERM');
    }, this.opts.closeGraceMs ?? 5000).unref?.();
  }

  private spawn(resume: boolean): void {
    const { session } = this.opts;
    let sessionArgs = resume ? ['--resume', session] : ['--session-id', session];
    if (!resume && this.opts.forkFrom) sessionArgs = ['--resume', this.opts.forkFrom, '--fork-session', ...sessionArgs];
    this.writeSettings();
    const args = [
      ...sessionArgs,
      '--permission-mode',
      this.mode === 'manual' ? 'default' : this.mode,
      ...(this.opts.chrome ? ['--chrome'] : []),
      ...(this.effort ? ['--effort', this.effort] : []),
      // One folder per flag, each followed by another flag: --add-dir takes a list.
      ...(this.opts.addDirs ?? []).flatMap((dir) => ['--add-dir', dir]),
      // Only for the `summon` tool: this engine's approvals come through hooks, not `approve`.
      ...(this.opts.permissionUrl ? ['--mcp-config', mcpConfig(this.opts.permissionUrl)] : []),
      '--settings',
      this.settingsFile,
    ];
    this.ready = false;
    this.processEffort = this.effort;
    this.resumed = resume;
    if (resume) this.hasConversation = true;
    this.trustAnswered = false;
    this.screen = '';
    const pty = this.spawnPty(this.opts.claudeBin ?? process.env.CLAUDE_BIN ?? 'claude', args, {
      name: 'xterm-256color',
      cols: COLS,
      rows: ROWS,
      cwd: this.opts.cwd,
      env: childEnv(this.opts.env ?? process.env, session),
    });
    this.pty = pty;
    this.term?.dispose();
    const term = new headless.Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
    this.term = term;
    pty.onData((data) => {
      term.write(data);
      this.onScreen(data);
      this.showScreen();
    });
    pty.onExit(({ exitCode }) => this.onExit(pty, exitCode));
    this.clearStartWatch();
    // A dialog before the input box stops SessionStart from ever coming.
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (!this.ready && this.pty === pty && !this.closing) this.raiseTerminal();
    }, this.opts.startWaitMs ?? START_WAIT_MS);
    this.startTimer.unref?.();
  }

  private writeSettings(): void {
    const hooks: Record<string, unknown> = {};
    for (const [event, timeout] of Object.entries(HOOK_EVENTS)) {
      const url = `${this.opts.hookUrl}/${event}`;
      const command = `curl -sS -X POST -H 'Content-Type: application/json' --data-binary @- '${url}'`;
      hooks[event] = [{ hooks: [{ type: 'command', command, timeout }] }];
    }
    // Replaces any statusline of the user's for this session only: its terminal is never shown.
    const statusLine = {
      type: 'command',
      command: `curl -sS -X POST -H 'Content-Type: application/json' --data-binary @- '${this.opts.hookUrl}/StatusLine'`,
      padding: 0,
    };
    writeFileSync(this.settingsFile, JSON.stringify({ hooks, statusLine }), { mode: 0o600 });
  }

  /** Only the workspace-trust dialog is read off the screen: the user chose this folder, so it's accepted. */
  private onScreen(data: string): void {
    if (this.trustAnswered) return;
    this.screen = (this.screen + screenWords(data)).slice(-4000);
    if (!this.screen.includes('Yes,Itrustthisfolder')) return;
    this.trustAnswered = true;
    const pty = this.pty;
    setTimeout(() => {
      // The cursor starts on "No, exit".
      pty?.write('\x1b[B');
      setTimeout(() => pty?.write('\r'), TRUST_ACCEPT_DELAY_MS);
    }, TRUST_ACCEPT_DELAY_MS);
  }

  private onHook(event: string, body: Record<string, unknown>): void {
    // The turn's milestones, so a turn that ends or restarts unexpectedly can be traced in the log.
    if (event === 'SessionStart' || event === 'UserPromptSubmit' || event === 'Stop') {
      const state = `turn ${this.turnOpen ? 'open' : 'closed'}${this.restartWith !== null ? ', restarting' : ''}`;
      console.error(`[crystal:interactive] ${this.opts.session} ${event} hook (${state})`);
    }
    if (event === 'SessionStart') {
      this.clearStartWatch();
      const transcript = typeof body.transcript_path === 'string' ? body.transcript_path : undefined;
      if (transcript && !this.tail) {
        // The skills and tools listed so far, e.g. a resumed session's, before the tail skips that part.
        this.scanListing(transcript);
        // A resumed session's history is already on the hub; follow only what this process adds.
        this.tail = new TranscriptTail(transcript, this.resumed);
        this.poll = setInterval(() => this.readTranscript(), this.opts.pollMs ?? 250);
      }
      this.initBase = {
        type: 'system',
        subtype: 'init',
        session_id: this.opts.session,
        cwd: this.opts.cwd,
        permissionMode: this.mode === 'manual' ? 'default' : this.mode,
        ...(typeof body.model === 'string' ? { model: body.model } : {}),
      };
      this.emitInit();
      setTimeout(() => {
        this.ready = true;
        this.closeTerminal();
        const typed = this.pending.splice(0);
        for (const text of typed) this.type(text);
        if (typed.length > 0) {
          this.awaiting = typed.join('\n\n');
          this.watchSubmit();
        }
      }, this.opts.readyDelayMs ?? 1000);
      return;
    }
    if (event === 'UserPromptSubmit') {
      this.taken();
      return;
    }
    if (event === 'Stop') {
      this.clearSubmitWatch();
      this.closeTerminal();
      const tasks = Array.isArray(body.background_tasks) ? body.background_tasks : [];
      // Documented as in-flight work, but each entry carries a status: a finished one mustn't hold deploys.
      // Monitors are passive watches (e.g. a live artifact subscription) that never end; a restart only drops a watch
      // the Quest can re-arm, so they don't count as work a deploy must wait for.
      const live = tasks.filter((task) => !isFinished(task) && field(task, 'type') !== 'monitor');
      this.background = live.length > 0;
      if (tasks.length > 0) {
        const summary = tasks.map((task) => `${field(task, 'type') ?? '?'}:${field(task, 'status') ?? '?'}`).join(', ');
        console.error(`[crystal:interactive] ${this.opts.session} background tasks at Stop: ${summary}`);
      }
      const reply = typeof body.last_assistant_message === 'string' ? body.last_assistant_message : '';
      // The CLI runs Stop before it writes the reply's last text to the transcript: finish the turn once that
      // text has come through, so the reply shows before the result, or after a moment regardless.
      this.stopping = { reply, timer: setTimeout(() => this.finishTurn(), this.opts.stopWaitMs ?? 2000) };
      this.readTranscript();
      return;
    }
    if (event === 'StatusLine') {
      this.onStatusLine(body);
      return;
    }
    if (event === 'Notification') {
      const kind = body.notification_type ?? body.type;
      // Like an approval this can wait on a person for as long as it takes, so nothing gives up on it.
      if (typeof kind === 'string' && TERMINAL_ONLY.has(kind)) this.raiseTerminal({ patient: true });
    }
  }

  /** The statusline's documented input: running cost, the context window, plan limits. */
  private onStatusLine(body: Record<string, unknown>): void {
    const cost = isObj(body.cost) ? body.cost : {};
    const costRose = typeof cost.total_cost_usd === 'number' && cost.total_cost_usd !== this.cost;
    if (typeof cost.total_cost_usd === 'number') {
      this.cost = cost.total_cost_usd;
      this.costAtTurnStart ??= this.cost;
    }
    const context = isObj(body.context_window) ? body.context_window : {};
    const size = context.context_window_size;
    const model = isObj(body.model) && typeof body.model.id === 'string' ? body.model.id : undefined;
    if (typeof size === 'number' && (size !== this.contextWindow || model !== this.contextModel)) {
      this.contextWindow = size;
      this.contextModel = model;
      const compactWindow = this.opts.compactWindow?.(model);
      // Sent now, not with the turn's result: the MP meter needs it during a Quest's first turn.
      this.emitEvent({
        type: 'claude.event',
        payload: {
          engine: 'claude',
          raw: {
            type: 'system',
            subtype: 'context_window',
            contextWindow: size,
            ...(compactWindow !== undefined ? { compactWindow } : {}),
          },
        },
      });
    }
    const usage = usageFromStatusLine(body);
    const json = usage ? JSON.stringify(usage) : '';
    if (usage && json !== this.lastUsage) {
      this.lastUsage = json;
      this.emitEvent({ type: 'usage', payload: usage });
    }
    if (costRose && this.stopping?.settling) this.finishTurn();
  }

  private scanListing(transcript: string): void {
    let text: string;
    try {
      text = readFileSync(transcript, 'utf8');
    } catch {
      return;
    }
    for (const raw of text.split('\n')) {
      if (!raw.includes('"attachment"')) continue;
      try {
        applyListing(this.listing, JSON.parse(raw));
      } catch {
        // A torn line: skip it.
      }
    }
  }

  /** The init line the client reads the Inventory from, sent again only when the listing changed. */
  private emitInit(): void {
    if (!this.initBase) return;
    const fields = listingFields(this.listing);
    this.lastListing = JSON.stringify(fields);
    this.emitEvent({ type: 'claude.event', payload: { engine: 'claude', raw: { ...this.initBase, ...fields } } });
  }

  private countTokens(raw: unknown): void {
    if (!isObj(raw) || raw.type !== 'assistant' || !isObj(raw.message)) return;
    const { id, usage } = raw.message;
    if (typeof id !== 'string' || !isObj(usage) || this.countedMessages.has(id)) return;
    this.countedMessages.add(id);
    for (const key of Object.keys(this.turnTokens) as (keyof typeof this.turnTokens)[]) {
      if (typeof usage[key] === 'number') this.turnTokens[key] += usage[key];
    }
  }

  private readTranscript(): void {
    if (this.tail) {
      let listingChanged = false;
      for (const line of this.tail.read()) {
        if (this.submitTimer && isConversationLine(line)) this.taken();
        if (typeof line === 'object' && line !== null && (line as { type?: unknown }).type === 'cost-state') {
          const total = (line as { totalCostUSD?: unknown }).totalCostUSD;
          if (typeof total === 'number') this.cost = total;
          continue;
        }
        if (applyListing(this.listing, line)) {
          listingChanged = true;
          continue;
        }
        const payload = liveTranscriptEvent(line);
        if (!payload) continue;
        this.countTokens(payload.raw);
        this.emitEvent({ type: 'claude.event', payload });
        const text = replyText(payload.raw);
        if (text !== undefined) this.lastText = text;
      }
      if (listingChanged && JSON.stringify(listingFields(this.listing)) !== this.lastListing) this.emitInit();
    }
    const stopping = this.stopping;
    if (stopping && (stopping.reply.trim() === '' || this.lastText.trim() === stopping.reply.trim())) this.settle();
  }

  /** The reply is in, but a debounced statusline may still owe the last request's cost: give it a moment. */
  private settle(): void {
    const stopping = this.stopping;
    if (!stopping || stopping.settling) return;
    const wait = this.opts.costSettleMs ?? 600;
    if (wait === 0) {
      this.finishTurn();
      return;
    }
    stopping.settling = true;
    clearTimeout(stopping.timer);
    stopping.timer = setTimeout(() => this.finishTurn(), wait);
  }

  /** Ends the turn the Stop hook announced: the result line the client shows, and the engine-neutral event. */
  private finishTurn(): void {
    const stopping = this.stopping;
    if (!stopping) return;
    clearTimeout(stopping.timer);
    this.stopping = null;
    this.turnOpen = false;
    this.lastText = '';
    // The stream engine's result shape: running cost, and this turn's own tokens and whole length.
    const tokens = this.turnTokens;
    const counted = Object.values(tokens).some((n) => n > 0);
    const durationMs = Date.now() - this.turnSince;
    this.emitEvent({
      type: 'claude.event',
      payload: {
        engine: 'claude',
        raw: {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: stopping.reply,
          session_id: this.opts.session,
          ...(this.cost !== undefined ? { total_cost_usd: this.cost } : {}),
          duration_ms: durationMs,
          ...(counted ? { usage: { ...tokens } } : {}),
          // Keyed by a neutral name: the client takes the only window there is.
          ...(this.contextWindow !== undefined
            ? { modelUsage: { session: { contextWindow: this.contextWindow } } }
            : {}),
        },
      },
    });
    const turnCost =
      this.cost === undefined
        ? undefined
        : this.costAtTurnStart !== undefined && this.cost >= this.costAtTurnStart
          ? this.cost - this.costAtTurnStart
          : this.cost;
    const neutral = neutralTokens(counted ? tokens : undefined);
    this.turnTokens = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    this.costAtTurnStart = this.cost;
    const summary = stopping.reply.trim().slice(0, SUMMARY_CHARS);
    this.emitEvent({
      type: 'turn.finished',
      payload: {
        outcome: 'success',
        ...(summary ? { summary } : {}),
        ...(turnCost !== undefined ? { costUsd: turnCost } : {}),
        durationMs,
        ...(neutral ? { tokens: neutral } : {}),
      },
    });
    reportChanges(this.opts.changes, (payload) => this.emitEvent({ type: 'claude.event', payload }));
  }

  /**
   * A terminal-only screen (a dialog or a setup command the bridge can't see) can swallow typed text, leaving the
   * Quest looking busy forever. If the CLI doesn't submit the prompt in time, restart the terminal on the same
   * conversation and type it again, once; failing that, or with background work a restart would kill, say what the
   * terminal showed and end the turn.
   */
  private watchSubmit(): void {
    this.clearSubmitWatch();
    this.submitTimer = setTimeout(() => {
      this.submitTimer = null;
      if (!this.turnOpen || this.stopping) return;
      const shown = this.shownLines();
      console.error(
        `[crystal:interactive] ${this.opts.session} terminal didn't take a typed message; it showed:\n${shown.join('\n')}`,
      );
      const text = this.awaiting;
      // A dialog that offers Esc (e.g. "esc not now") took the text: dismiss it and type the message again.
      if (text !== null && !this.escaped && /\besc\b/i.test(shown.at(-1) ?? '') && this.pty) {
        this.escaped = true;
        this.pty.write('\x1b');
        setTimeout(() => {
          if (!this.turnOpen || this.awaiting !== text) return;
          this.type(text);
          this.watchSubmit();
        }, this.opts.dialogSettleMs ?? 300).unref?.();
        return;
      }
      if (text !== null && !this.retried && !this.background && this.hasConversation && this.pty) {
        this.retried = true;
        this.restartWith = text;
        this.pty.kill('SIGTERM');
        return;
      }
      this.raiseTerminal();
    }, this.opts.submitWaitMs ?? 20_000);
    this.submitTimer.unref?.();
  }

  /**
   * Shows the app what's on the terminal, because the automatic ways out are spent and it takes a person: the CLI's
   * dialogs change with each release, so they're passed through rather than recognised. New in the turn's event stream,
   * so a reload or a second device sees the same card.
   */
  private raiseTerminal({ patient = false }: { patient?: boolean } = {}): void {
    if (this.asking || !this.pty) return;
    this.asking = true;
    this.lastShown = this.screenText();
    this.emitEvent({
      type: 'terminal.screen',
      payload: { open: true, raised: true, held: this.awaiting !== null, text: this.lastShown },
    });
    if (!patient) this.armAskTimer();
  }

  /** Nobody can be relied on to answer, and a busy Quest holds deploys and updates, so a card doesn't wait forever. */
  private armAskTimer(): void {
    if (this.askTimer) clearTimeout(this.askTimer);
    this.askTimer = setTimeout(() => this.giveUpAsking(), this.opts.terminalWaitMs ?? TERMINAL_WAIT_MS);
    this.askTimer.unref?.();
  }

  private giveUpAsking(): void {
    const shown = this.shownLines();
    const started = this.ready;
    this.closeTerminal();
    if (!this.turnOpen) return;
    this.turnOpen = false;
    this.awaiting = null;
    const what = shown.length > 0 ? `\n\nThe terminal showed:\n${shown.join('\n')}` : '';
    this.emitEvent({
      type: 'error',
      payload: {
        message: `This Quest's terminal didn't take your message: it may be showing a screen only the terminal shows. Stop and send it again, or answer it with \`claude --resume ${this.opts.session}\` in a terminal.${what}`,
      },
    });
    this.emitEvent({ type: 'turn.finished', payload: { outcome: 'error' } });
    // It never reached the input box, so only a new process can take the next message.
    if (!started) this.pty?.kill('SIGTERM');
  }

  /** Sends the screen once it has settled for a moment, if it changed. */
  private showScreen(): void {
    if (!this.asking || this.screenTimer) return;
    this.screenTimer = setTimeout(() => {
      this.screenTimer = null;
      if (!this.asking) return;
      const text = this.screenText();
      if (text === this.lastShown) return;
      this.lastShown = text;
      this.emitEvent({ type: 'terminal.screen', payload: { open: true, text } });
    }, this.opts.screenUpdateMs ?? SCREEN_UPDATE_MS);
    this.screenTimer.unref?.();
  }

  private closeTerminal(): void {
    if (this.askTimer) clearTimeout(this.askTimer);
    if (this.screenTimer) clearTimeout(this.screenTimer);
    this.askTimer = null;
    this.screenTimer = null;
    if (!this.asking) return;
    this.asking = false;
    this.emitEvent({ type: 'terminal.screen', payload: { open: false } });
  }

  /** The whole mirrored screen as text, keeping its layout, without the blank rows below it. */
  private screenText(): string {
    const buffer = this.term?.buffer.active;
    if (!buffer) return '';
    const lines: string[] = [];
    for (let row = buffer.baseY; row < buffer.baseY + ROWS; row++) {
      lines.push(buffer.getLine(row)?.translateToString(true).trimEnd() ?? '');
    }
    while (lines.at(-1) === '') lines.pop();
    return lines.join('\n');
  }

  /** The last non-empty lines on the mirrored screen, trimmed. */
  private shownLines(): string[] {
    const buffer = this.term?.buffer.active;
    if (!buffer) return [];
    const lines: string[] = [];
    for (let row = buffer.baseY; row < buffer.baseY + ROWS; row++) {
      const line = buffer.getLine(row)?.translateToString(true).trim();
      if (line) lines.push(line);
    }
    return lines.slice(-SHOWN_LINES);
  }

  /** The CLI took the typed message: it submitted a prompt or recorded one (a `!` command fires no hook). */
  private taken(): void {
    this.clearSubmitWatch();
    this.closeTerminal();
    this.hasConversation = true;
    this.awaiting = null;
  }

  private clearSubmitWatch(): void {
    if (this.submitTimer) clearTimeout(this.submitTimer);
    this.submitTimer = null;
  }

  private clearStartWatch(): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  private type(text: string): void {
    this.pty?.write(paste(text));
    this.pty?.write('\r');
  }

  private onExit(pty: PtyLike, exitCode: number): void {
    if (this.pty !== pty) return;
    this.clearSubmitWatch();
    this.clearStartWatch();
    this.closeTerminal();
    this.readTranscript();
    this.finishTurn();
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    this.tail?.close();
    this.tail = null;
    this.pty = null;
    this.ready = false;
    this.background = false;
    const retry = this.restartWith;
    this.restartWith = null;
    if (retry !== null && !this.closing) {
      // Killed on purpose: the turn stays open and the message goes to the --resume process.
      this.spawn(true);
      this.emitEvent({ type: 'session.resumed', payload: {} });
      this.pending.push(retry);
      return;
    }
    const failed = exitCode !== 0 && !this.closing;
    if (failed) this.emitEvent({ type: 'error', payload: { message: `claude exited with code ${exitCode}` } });
    if (this.turnOpen) {
      this.turnOpen = false;
      this.emitEvent({ type: 'turn.finished', payload: { outcome: failed ? 'error' : 'interrupted' } });
    }
    this.emitEvent({ type: 'session.ended', payload: { exitCode, signal: null, reason: failed ? 'error' : 'exit' } });
    if (this.closing) this.opts.hooks.unregister(this.opts.session);
    for (const resolve of this.stopWaiters.splice(0)) resolve();
  }

  private emitEvent(event: ClaudeSessionEvent): void {
    this.emit('event', event);
  }
}
