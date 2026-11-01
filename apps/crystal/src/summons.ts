import { randomUUID } from 'node:crypto';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MAX_CAST_COMMAND, MAX_CAST_TAIL, type Cast, type CastFinish, type Summon } from '@crystal-bridge/protocol';
import {
  FINISHED_LINE,
  FOLLOW_LINE,
  posixScripts,
  QUEUED_LINE,
  STARTED_QUEUED,
  TURN_LINE,
  type TargetScripts,
} from './summon-scripts.js';
import { NOT_DETACHED, windowsEnvelope, WINDOWS_COMMAND, windowsScripts } from './summon-scripts-windows.js';

/** What a Quest calls the Kingdom it runs on. */
export const HERE = 'here';

/** A machine a Kingdom may use. No `host` means the Kingdom itself, which needs no SSH. */
export interface Target {
  name: string;
  host?: string;
  /** How many Casts it runs at once; unset is one. */
  limit?: number;
}

const HOST = /^[A-Za-z0-9_][A-Za-z0-9._:@-]*$/;

/** `CRYSTAL_SUMMONS`: SSH host names, each with an optional `name=` of the user's and `/limit`. */
export function parseSummons(value: string | undefined, platform: NodeJS.Platform): Target[] {
  const targets: Target[] = platform === 'win32' ? [] : [{ name: HERE }];
  for (const entry of (value ?? '').split(',')) {
    const text = entry.trim();
    if (!text) continue;
    const parts = /^(?:([^=]+)=)?([^=/]+)(?:\/([1-9]\d*))?$/.exec(text);
    const host = parts?.[2]?.trim() ?? '';
    const name = parts?.[1]?.trim() ?? host;
    if (!name || name.startsWith('-') || !HOST.test(host)) {
      throw new Error(`CRYSTAL_SUMMONS: "${text}" isn't an SSH host name, with an optional name= and /limit`);
    }
    targets.push({ name, host, ...(parts?.[3] ? { limit: Number(parts[3]) } : {}) });
  }
  return targets;
}

/**
 * The machine's own `ssh`, with its own config, keys and agent. `BatchMode` means it fails rather than prompts, since
 * a service has no terminal. `LogLevel=ERROR` keeps the client's own warnings and a server's banner out of what the
 * target said, and leaves its real failures in. The keepalive is what ends a connection to a machine that went away.
 */
export function sshArgs(host: string, command = 'sh -s'): string[] {
  return [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'LogLevel=ERROR',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    '--',
    host,
    command,
  ];
}

/** How `ssh` exits when the connection failed, as opposed to the command on the far side. */
const SSH_FAILED = 255;

/** Which wrapper a target takes. */
export type TargetKind = 'posix' | 'windows';

/** Starts a shell on a target, reading its script from stdin: SSH for a Summon, directly for the Kingdom itself. */
export function targetShell(env: NodeJS.ProcessEnv, home: string) {
  return (target: Target, kind: TargetKind = 'posix'): ChildProcessWithoutNullStreams =>
    target.host
      ? spawn('ssh', sshArgs(target.host, kind === 'windows' ? WINDOWS_COMMAND : 'sh -s'), { env })
      : spawn('sh', ['-s'], { env: { ...env, HOME: home }, cwd: home });
}

/**
 * Tells a Windows target from any other by what `uname` says, or by having none. Git for Windows brings one, and its
 * `sh` would run the wrapper, but not outlive the SSH session. Rejects if the machine can't be reached, which says
 * nothing about what it is. The answer can't change, so a Kingdom asks once.
 */
export function targetKind(env: NodeJS.ProcessEnv) {
  return (target: Target): Promise<TargetKind> => {
    if (!target.host) return Promise.resolve('posix');
    return new Promise((resolve, reject) => {
      const child = spawn('ssh', sshArgs(target.host!, 'uname -s'), { env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data: Buffer) => (stdout += data.toString()));
      child.stderr.on('data', (data: Buffer) => (stderr += data.toString()));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === SSH_FAILED) reject(new Error(stderr.trim().slice(-500) || 'no answer'));
        else resolve(code === 0 && !/MINGW|MSYS|CYGWIN/.test(stdout) ? 'posix' : 'windows');
      });
      child.stdin.end();
    });
  };
}

export interface SummonsOptions {
  targets: readonly Target[];
  /** The record of running Casts, so a restart can find them. */
  statePath: string;
  spawnOn: (target: Target, kind: TargetKind) => ChildProcessWithoutNullStreams;
  /** Which wrapper a target takes; default POSIX. */
  kindOf?: (target: Target) => Promise<TargetKind>;
  /** A Cast changed; the hub hears it. */
  report: (cast: Cast) => void;
  log?: (message: string) => void;
  now?: () => number;
  /** How often to check a job is still there, for a wrapper killed with the connection left up. Default 3 minutes. */
  probeMs?: number;
  /** The first wait before reconnecting; it doubles to `MAX_RETRY_MS`. */
  retryMs?: number;
  /** How often a Cast's log end goes to the hub. */
  reportMs?: number;
  /** How long a job found finished gets for its last lines to arrive. */
  settleMs?: number;
}

export interface StartCast {
  session: string;
  summon: string;
  command: string;
  onFinish: CastFinish;
  name?: string | undefined;
  cwd?: string | undefined;
}

export interface Summons {
  /** The machines this Kingdom may use. */
  list(): Summon[];
  /** Every Cast still on record. */
  casts(): Cast[];
  start(input: StartCast): Promise<Cast>;
  /** This Quest's Casts, or one of them. A Quest sees only its own. */
  status(session: string, id?: string): Cast[];
  cancel(session: string, id: string): Promise<Cast>;
  /** Picks up the Casts on record, after a restart. */
  resume(): void;
  /** Stops following. Nothing on a target is touched. */
  close(): void;
}

/** A Cast as the Kingdom keeps it. */
interface CastRecord extends Cast {
  /** Bytes of the log read so far. */
  offset: number;
  /** A cancel is on its way, so however the job ends, it was cancelled. */
  cancelling?: boolean;
}

interface Follower {
  child?: ChildProcessWithoutNullStreams;
  pending: Buffer;
  /** Past the noise of a shell's startup files. */
  inLog: boolean;
  retryMs: number;
  retry?: NodeJS.Timeout;
  reportTimer?: NodeJS.Timeout;
  /** The check in progress, for anyone who needs its answer. */
  checking?: Promise<void>;
}

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

const NAME_LINE = /^::summon name (.+)$/;
const PROGRESS_LINE = /^::summon progress (\d+)\/(\d+)(?: (.*))?$/;
const NEWLINE = 10;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_RETRY_MS = 5 * 60_000;
const SAVE_MS = 2000;
const SHORT_TIMEOUT_MS = 30_000;
/** A start waits on `ssh` connecting; a cancel waits out the job's own shutdown. */
const LONG_TIMEOUT_MS = 60_000;
/** Finished Casts stay on record, and their folders on the target, this long. */
const KEEP_MS = 7 * 24 * 60 * 60_000;

function firstWord(command: string): string {
  return command.trim().split(/\s+/, 1)[0]!.slice(0, 200);
}

function outward({ offset: _offset, cancelling: _cancelling, ...cast }: CastRecord): Cast {
  return cast;
}

export function createSummons(options: SummonsOptions): Summons {
  const { targets, statePath, spawnOn, report } = options;
  const log = options.log ?? ((message) => console.error(`[crystal:summons] ${message}`));
  const now = options.now ?? Date.now;
  const retryMs = options.retryMs ?? 5000;
  const reportMs = options.reportMs ?? 2000;
  const settleMs = options.settleMs ?? 1000;

  const records = new Map<string, CastRecord>();
  const followers = new Map<string, Follower>();
  /** Targets with a clean-up on its way. */
  const cleaning = new Set<string>();
  let closed = false;
  let saveTimer: NodeJS.Timeout | undefined;

  const targetOf = (rec: CastRecord) => targets.find((target) => target.name === rec.summon);

  const kinds = new Map<string, TargetKind>();
  /** Rejects when a target can't be reached yet. */
  async function kindOf(target: Target): Promise<TargetKind> {
    const known = kinds.get(target.name);
    if (known) return known;
    const kind = (await options.kindOf?.(target)) ?? 'posix';
    kinds.set(target.name, kind);
    return kind;
  }
  const scriptsFor = (kind: TargetKind): TargetScripts => (kind === 'windows' ? windowsScripts : posixScripts);
  const framed = (kind: TargetKind, script: string) => (kind === 'windows' ? windowsEnvelope(script) : script);

  function save(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = undefined;
    try {
      mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
      const temporary = `${statePath}.tmp`;
      writeFileSync(temporary, JSON.stringify({ casts: [...records.values()] }), { mode: 0o600 });
      renameSync(temporary, statePath);
    } catch (error) {
      log(`could not save the Casts: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function saveSoon(): void {
    saveTimer ??= setTimeout(save, SAVE_MS);
    saveTimer.unref?.();
  }

  function load(): void {
    let text: string;
    try {
      text = readFileSync(statePath, 'utf8');
    } catch {
      return;
    }
    try {
      for (const rec of (JSON.parse(text) as { casts: CastRecord[] }).casts) records.set(rec.id, rec);
    } catch (error) {
      log(`could not read the Casts: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Runs a script to its end. A connection that fails gives a code, never a throw. */
  function short(target: Target, kind: TargetKind, script: string, timeoutMs = SHORT_TIMEOUT_MS): Promise<Result> {
    return new Promise((resolve) => {
      const child = spawnOn(target, kind);
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.stdout.on('data', (data: Buffer) => (stdout += data.toString()));
      child.stderr.on('data', (data: Buffer) => (stderr += data.toString()));
      child.stdin.on('error', () => {});
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr: error.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      child.stdin.end(framed(kind, script));
    });
  }

  /** Runs a script a target's kind picks, or reports that the target can't be reached. */
  async function ask(
    target: Target,
    script: (scripts: TargetScripts) => string,
    timeoutMs = SHORT_TIMEOUT_MS,
  ): Promise<Result> {
    let kind: TargetKind;
    try {
      kind = await kindOf(target);
    } catch (error) {
      return { code: null, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
    }
    return short(target, kind, script(scriptsFor(kind)), timeoutMs);
  }

  function reportSoon(rec: CastRecord, follower: Follower): void {
    if (follower.reportTimer) return;
    follower.reportTimer = setTimeout(() => {
      follower.reportTimer = undefined;
      if (rec.state === 'running') report(outward(rec));
    }, reportMs);
    follower.reportTimer.unref?.();
  }

  /** Acts on a line meant for the app, if it's one. Anything else that looks like one is just the log. */
  function readSignal(rec: CastRecord, text: string): boolean {
    if (text === QUEUED_LINE) {
      rec.queued = true;
      return true;
    }
    if (text === TURN_LINE) {
      delete rec.queued;
      return true;
    }
    const name = NAME_LINE.exec(text)?.[1]?.trim();
    if (name) {
      rec.name = name.slice(0, 200);
      return true;
    }
    const progress = PROGRESS_LINE.exec(text);
    if (progress && Number(progress[2]) > 0) {
      const label = progress[3]?.trim();
      rec.progress = {
        done: Number(progress[1]),
        total: Number(progress[2]),
        ...(label ? { label: label.slice(0, 200) } : {}),
      };
      return true;
    }
    return false;
  }

  function onLine(rec: CastRecord, follower: Follower, line: Buffer): void {
    const text = line.toString('utf8').replace(/\r$/, '');
    if (!follower.inLog) {
      if (text === FOLLOW_LINE) follower.inLog = true;
      return;
    }
    rec.offset += line.length + 1;
    if (text === FINISHED_LINE) {
      // The wrapper's own newline goes first, for a log that didn't end its last line.
      if (rec.logTail === '\n' || rec.logTail.endsWith('\n\n')) rec.logTail = rec.logTail.slice(0, -1);
      // Read to the end, so there's nothing left to wait for.
      void check(rec, false);
      return;
    }
    if (!readSignal(rec, text)) rec.logTail = `${rec.logTail}${text}\n`.slice(-MAX_CAST_TAIL);
    reportSoon(rec, follower);
    saveSoon();
  }

  function onData(rec: CastRecord, follower: Follower, data: Buffer): void {
    follower.retryMs = retryMs;
    let pending = follower.pending.length ? Buffer.concat([follower.pending, data]) : data;
    for (;;) {
      const end = pending.indexOf(NEWLINE);
      if (end < 0) break;
      onLine(rec, follower, pending.subarray(0, end));
      pending = pending.subarray(end + 1);
    }
    if (pending.length > MAX_LINE_BYTES) {
      // A very long line, such as a progress bar drawn with carriage returns: show it in pieces.
      const { inLog } = follower;
      if (inLog) rec.offset += pending.length;
      if (inLog) rec.logTail = `${rec.logTail}${pending.toString('utf8')}`.slice(-MAX_CAST_TAIL);
      pending = Buffer.alloc(0);
    }
    follower.pending = pending;
  }

  function stopFollowing(id: string): void {
    const follower = followers.get(id);
    if (!follower) return;
    followers.delete(id);
    if (follower.retry) clearTimeout(follower.retry);
    if (follower.reportTimer) clearTimeout(follower.reportTimer);
    follower.child?.stdin.end();
    follower.child?.kill();
  }

  function follow(rec: CastRecord): void {
    const target = targetOf(rec);
    const follower = followers.get(rec.id) ?? { pending: Buffer.alloc(0), inLog: false, retryMs };
    followers.set(rec.id, follower);
    follower.pending = Buffer.alloc(0);
    follower.inLog = false;
    if (!target) {
      // Taken off the list while it ran: nothing here can reach it any more.
      void finish(rec, 'lost');
      return;
    }
    const retry = () => {
      if (followers.get(rec.id) !== follower || closed || rec.state !== 'running') return;
      follower.retry = setTimeout(() => {
        follow(rec);
        void check(rec);
      }, follower.retryMs);
      follower.retry.unref?.();
      follower.retryMs = Math.min(follower.retryMs * 2, MAX_RETRY_MS);
    };
    kindOf(target).then((kind) => {
      if (followers.get(rec.id) !== follower || closed) return;
      const child = spawnOn(target, kind);
      follower.child = child;
      child.stdout.on('data', (data: Buffer) => onData(rec, follower, data));
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => {});
      child.on('error', (error) => log(`could not reach ${rec.summon}: ${error.message}`));
      child.on('close', retry);
      child.stdin.write(framed(kind, scriptsFor(kind).follow(rec.id, rec.offset)));
    }, retry);
  }

  /** Asks the target how a job stands, and acts on a final answer. Not reaching it says nothing about the job. */
  async function check(rec: CastRecord, settle = true): Promise<void> {
    const follower = followers.get(rec.id);
    const target = targetOf(rec);
    if (!follower || !target || rec.state !== 'running') return;
    if (follower.checking) return follower.checking;
    const checking = probe(rec, target, settle).finally(() => {
      follower.checking = undefined;
    });
    follower.checking = checking;
    return checking;
  }

  async function probe(rec: CastRecord, target: Target, settle: boolean): Promise<void> {
    const { code, stdout } = await ask(target, (scripts) => scripts.probe(rec.id));
    if (code !== 0) return;
    const answer = stdout.trim().split('\n').at(-1) ?? '';
    const exit = /^exit (\d+)( cancelled)?$/.exec(answer);
    if (exit) {
      // Found rather than read to the end of the log, so its last lines may still be on their way.
      if (settle) await new Promise((resolve) => setTimeout(resolve, settleMs));
      const cancelled = exit[2] !== undefined || rec.cancelling === true;
      const exitCode = Number(exit[1]);
      finish(rec, cancelled ? 'cancelled' : exitCode === 0 ? 'succeeded' : 'failed', exitCode);
    } else if (answer === 'dead' || answer === 'gone') {
      finish(rec, 'lost');
    }
  }

  function finish(rec: CastRecord, state: Cast['state'], exitCode?: number): void {
    if (rec.state !== 'running' || closed) return;
    stopFollowing(rec.id);
    rec.state = state;
    rec.finishedAt = now();
    if (exitCode !== undefined) rec.exitCode = exitCode;
    save();
    report(outward(rec));
  }

  /**
   * Removes one target's folders, forgetting each Cast only once the target says its folder has gone. One at a time,
   * and a target that can't be reached ends the pass, so a machine that's off costs one connection however many wait.
   */
  async function clean(target: Target, expired: readonly CastRecord[]): Promise<void> {
    cleaning.add(target.name);
    for (const rec of expired) {
      const { code } = await ask(target, (scripts) => scripts.clean(rec.id));
      if (closed) break;
      if (code === 0) {
        records.delete(rec.id);
        save();
      } else if (code === null || code === SSH_FAILED) {
        break;
      }
    }
    cleaning.delete(target.name);
  }

  /** Cleans up finished Casts past their time. A Summon taken off the list can't be reached, so its Casts just go. */
  function prune(): void {
    const expired = new Map<Target, CastRecord[]>();
    let changed = false;
    for (const rec of [...records.values()]) {
      if (rec.state === 'running' || now() - (rec.finishedAt ?? rec.startedAt) < KEEP_MS) continue;
      const target = targetOf(rec);
      if (target) {
        expired.set(target, [...(expired.get(target) ?? []), rec]);
      } else {
        records.delete(rec.id);
        changed = true;
      }
    }
    if (changed) save();
    for (const [target, recs] of expired) if (!cleaning.has(target.name)) void clean(target, recs);
  }

  const probeTimer = setInterval(
    () => {
      for (const rec of records.values()) if (rec.state === 'running' && followers.has(rec.id)) void check(rec);
      prune();
    },
    options.probeMs ?? 3 * 60_000,
  );
  probeTimer.unref?.();

  function mine(session: string, id: string): CastRecord {
    const rec = records.get(id);
    if (!rec || rec.session !== session) throw new Error(`no such Cast in this Quest: ${id}`);
    return rec;
  }

  return {
    list: () => targets.map((target) => ({ name: target.name, ...(target.host === undefined ? { local: true } : {}) })),
    casts: () => [...records.values()].map(outward),

    async start({ session, summon, command, onFinish, name, cwd }) {
      const target = targets.find((candidate) => candidate.name === summon);
      if (!target) {
        const names = targets.map((candidate) => candidate.name).join(', ');
        throw new Error(`no Summon called ${summon}. This Kingdom has: ${names}`);
      }
      if (!command.trim()) throw new Error('the command is empty');
      const id = randomUUID();
      const kind = await kindOf(target).catch((error: unknown) => {
        throw new Error(`could not reach ${summon}: ${error instanceof Error ? error.message : String(error)}`);
      });
      const script = scriptsFor(kind).start(id, command, cwd, target.limit);
      if (!script) throw new Error('the command holds a line reserved for the wrapper');
      const rec: CastRecord = {
        id,
        session,
        summon,
        name: (name?.trim() || firstWord(command)).slice(0, 200),
        command: command.slice(0, MAX_CAST_COMMAND),
        ...(cwd === undefined ? {} : { cwd }),
        onFinish,
        state: 'running',
        startedAt: now(),
        logTail: '',
        offset: 0,
      };
      // On record first: a restart in the middle of this finds the job, or reports it lost.
      records.set(id, rec);
      save();
      const { code, stdout, stderr } = await short(target, kind, script, LONG_TIMEOUT_MS);
      if (code !== 0 || !stdout.trim().endsWith('started')) {
        records.delete(id);
        save();
        const why = stderr.trim().slice(-500) || `it exited with ${code ?? 'no code'}`;
        throw new Error(`could not start on ${summon}: ${why}`);
      }
      // The follow will read this too, and it also hears the turn come.
      if (stdout.split('\n').some((line) => line.trim() === STARTED_QUEUED)) rec.queued = true;
      if (target.host && stdout.includes(NOT_DETACHED)) {
        rec.logTail = `This machine wouldn't let the job leave its SSH session, so it ended with that session.\n`;
      }
      report(outward(rec));
      if (!closed) follow(rec);
      return outward(rec);
    },

    status(session, id) {
      return [...records.values()]
        .filter((rec) => rec.session === session && (id === undefined || rec.id === id))
        .map(outward);
    },

    async cancel(session, id) {
      const rec = mine(session, id);
      if (rec.state !== 'running') return outward(rec);
      const target = targetOf(rec);
      if (!target) throw new Error(`${rec.summon} is no longer on this Kingdom's list`);
      rec.cancelling = true;
      save();
      const { code, stderr } = await ask(target, (scripts) => scripts.cancel(id), LONG_TIMEOUT_MS);
      if (code !== 0) {
        delete rec.cancelling;
        save();
        throw new Error(`could not reach ${rec.summon}: ${stderr.trim().slice(-500) || 'no answer'}`);
      }
      await check(rec);
      // That may have been a check already on its way, which asked before the job stopped.
      await check(rec);
      return outward(rec);
    },

    resume() {
      load();
      prune();
      for (const rec of records.values()) {
        if (rec.state !== 'running') continue;
        follow(rec);
        void check(rec);
      }
    },

    close() {
      closed = true;
      clearInterval(probeTimer);
      for (const id of [...followers.keys()]) stopFollowing(id);
      save();
    },
  };
}

/** What the `summon` tool tells an agent, naming the machines this Kingdom may use. */
export function summonDescription(targets: readonly Target[]): string {
  const names = targets.map((target) => (target.host === undefined ? `${target.name} (this machine)` : target.name));
  return [
    'Run a long job on a machine, then stop spending turns on it.',
    '`start` runs a command detached and returns at once with its Cast id. The job keeps running through dropped',
    'connections and restarts, and its log and result are kept for you and the user.',
    'Choose `onFinish` each time: `notify` tells the user and costs nothing, `wake` sends you a message with the result,',
    'which costs a turn. After starting, end your turn or do other work. Never poll with `status` or sleep to wait.',
    '`status` shows this Quest’s Casts, with the end of each log. `cancel` stops one, and a cancel sends no wake.',
    'A machine runs one Cast at a time by default, so a Cast may wait its turn: `queued: true` means it hasn’t begun.',
    'A script can print `::summon name Video Upscaler` to name its Cast, and `::summon progress 12/50 episode-12.mkv` to',
    'show a live count, from any language. Add these to a batch you write.',
    'The command runs in the machine’s own shell, so write PowerShell for a Windows machine.',
    'Use it for builds, renders, batches and anything else over a minute or so. A Cast is lost, not retried, if its',
    'machine restarts, since only you know whether it can safely run twice.',
    `Machines: ${names.join(', ')}.`,
  ].join(' ');
}

/** One call of the `summon` tool. The schema can't say which fields each action needs, so this does. */
export async function summonCall(summons: Summons, session: string, args: Record<string, unknown>): Promise<unknown> {
  const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);
  const cast = text(args.cast);
  if (args.action === 'status') return summons.status(session, cast);
  if (args.action === 'cancel') {
    if (!cast) throw new Error('cancel needs a cast: the id start gave you');
    return summons.cancel(session, cast);
  }
  const summon = text(args.summon);
  const command = text(args.command);
  if (!summon || !command) throw new Error('start needs a summon and command');
  if (args.onFinish !== 'notify' && args.onFinish !== 'wake') {
    throw new Error('start needs onFinish: notify (tells the user, costs nothing) or wake (costs a turn)');
  }
  const name = text(args.name);
  const cwd = text(args.cwd);
  return summons.start({
    session,
    summon,
    command,
    onFinish: args.onFinish,
    ...(name ? { name } : {}),
    ...(cwd ? { cwd } : {}),
  });
}
