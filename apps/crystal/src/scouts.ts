import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { Cron } from 'croner';
import { z } from 'zod';
import {
  MAX_SCOUT_STDERR,
  ScoutId,
  ScoutItems,
  ScoutManifest,
  type HubScoutAction,
  type NodeScoutRun,
  type PermissionMode,
  type Scout,
  type ScoutItem,
  type ScoutLink,
  type ScoutRun,
} from '@crystal-bridge/protocol';
import { resolveClaudeBin } from './claude-bin.js';
import { projectFor, questPrompt } from './scout-actions.js';
import {
  DEFAULT_SYNTHESIS_BUDGET_USD,
  applySynthesis,
  readSynthesis,
  synthesisArgs,
  synthesisDigest,
  synthesisPrompt,
  synthesisSchema,
  withoutSources,
  type SynthesisAnswer,
} from './scout-synthesis.js';

/**
 * Scouts (docs/SCOUTS.md): each folder under the Kingdom's scouts folder holds a `scout.json` and a collector. This
 * module finds them, runs each collector on its schedule and hands every finished run to the hub link. It never reads
 * a Scout's own state or any credential a collector uses.
 */

/** How long a collector may run when `scout.json` doesn't say. */
export const DEFAULT_TIMEOUT_SECONDS = 120;
/** Failed runs in a row that pause a Scout's schedule. */
export const FAILURES_TO_PAUSE = 3;
/** A due run found later than this was missed (the machine slept, or Crystal was down), so it runs as a catch-up. */
export const CATCH_UP_AFTER_MS = 2 * 60_000;
/** Runs kept per Scout to send again after a reconnect; the hub ignores one it already has. */
export const RUNS_KEPT = 5;
/** The most Scouts a Kingdom reports, as `NodeScouts` allows. */
const MAX_SCOUTS = 100;
/** How often the folder is read again and due runs started. A wall-clock check, so a sleep is noticed on waking. */
const TICK_MS = 10_000;
/** Jitter stays under this, so Scouts due at the same minute don't all start at once. */
const MAX_JITTER_MS = 30_000;
/** More than any list of `MAX_SCOUT_ITEMS` items needs. */
const MAX_STDOUT = 32 * 1024 * 1024;
/** How long a stopped collector gets to end before it's killed outright. */
const KILL_GRACE_MS = 5_000;
/** How long the pipes may stay open after a collector exits, on Windows where what it left behind can't be ended. */
const PIPE_GRACE_MS = 2_000;
/** As `ScoutRun.reason` allows. */
const MAX_REASON = 2000;
/** How long a `run` action's script may take. The hub waits a little longer for the answer. */
export const ACTION_TIMEOUT_SECONDS = 120;
/** The largest prompt template a `quest` action reads. */
const MAX_PROMPT_BYTES = 64 * 1024;
/** What a `run` action's script may print; nobody reads it. */
const MAX_ACTION_STDOUT = 1024 * 1024;
/** How long the synthesis step's `claude` call may take. */
export const SYNTHESIS_TIMEOUT_SECONDS = 180;
/** What that call may print: one result line, with the answer twice. */
const MAX_SYNTHESIS_STDOUT = 4 * 1024 * 1024;

export interface CollectRequest {
  cwd: string;
  command: string[];
  env: Record<string, string>;
  timeoutMs: number;
  /** Bytes of stdout allowed; default `MAX_STDOUT`. */
  maxStdout?: number;
  /** Written to its stdin, which is then closed; unset gives it no stdin. */
  stdin?: string;
}

export type CollectResult =
  | { kind: 'exited'; code: number | null; signal?: string | null; stdout: string; stderr: string }
  | { kind: 'timed-out'; stderr: string }
  | { kind: 'too-much'; stderr: string }
  | { kind: 'not-started'; message: string };

export interface Collector {
  result: Promise<CollectResult>;
  /** Ends it early, as when Crystal shuts down. */
  stop(): void;
}

/** A Quest a `quest` action asks for, started the way New Quest starts one. */
export interface QuestStart {
  cwd: string;
  prompt: string;
  mode?: PermissionMode;
  worktree?: boolean;
  /** The item it came from, so the Quest links back to it. */
  from: ScoutLink;
}

/** How an action went; `session` is the Quest a `quest` action started. */
export type ActResult = { ok: true; session?: string } | { ok: false; reason: string };

export interface ScoutsOptions {
  /** The folder holding one folder per Scout. */
  dir: string;
  /** Where `~` in a `quest` action's project points; default the user's home folder. */
  home?: string;
  /** Where each Scout's next run and failure count are kept across restarts. */
  statePath: string;
  /** The environment collectors get: the sessions' login environment, which holds no node token. */
  env: Record<string, string>;
  /** Runs a collector; `spawnCollector` in production. */
  collect?: (request: CollectRequest) => Collector;
  now?: () => number;
  /** The Scouts changed: their list, a definition, an error, a pause or a next run. */
  onScouts(scouts: Scout[]): void;
  /** A run ended; one that succeeded carries its whole list. */
  onRun(scout: string, run: ScoutRun, items: ScoutItem[] | undefined): void;
  log?: (line: string) => void;
}

export interface Scouts {
  /** The Scouts as the hub should see them. */
  list(): Scout[];
  /** Each Scout's latest runs, oldest first, to send again after a reconnect. */
  recent(): NodeScoutRun[];
  /** Runs a Scout at once (the Board's Run now), or records a skip if it's already running. */
  runNow(id: string): void;
  /** Carries out a `quest` or `run` action on items the hub sent, starting a Quest through `startQuest`. */
  act(request: HubScoutAction, startQuest: (start: QuestStart) => Promise<ActResult>): Promise<ActResult>;
  /** Reads the folder again and starts any run that's due. Runs on a timer after `start`. */
  tick(): Promise<void>;
  /** Resolves once no collector is running. */
  idle(): Promise<void>;
  /** Ticks on a timer until `close`. */
  start(): void;
  /** Stops the timer and every running collector, waiting for them a few seconds; their runs aren't reported. */
  close(): Promise<void>;
}

/** A fixed offset per Scout, from its id, so it's the same on every tick and every restart. */
export function jitterOf(id: string): number {
  let hash = 2166136261;
  for (const char of id) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % MAX_JITTER_MS;
}

/**
 * What's kept across restarts, per Scout. `schedule` is the cron and zone `next` was worked out for. Read leniently: a
 * value someone edited badly falls back to its default rather than breaking the count.
 */
const Saved = z.object({
  schedule: z.string(),
  next: z.number().int().optional().catch(undefined),
  failures: z.number().int().nonnegative().catch(0),
  /** Why it paused, when it did. */
  paused: z.string().optional().catch(undefined),
});
type Saved = z.infer<typeof Saved>;

interface Entry {
  id: string;
  /** The last `scout.json` that loaded. */
  manifest?: ScoutManifest;
  cron?: Cron;
  /** The text last read, so an unchanged file isn't parsed again. */
  text?: string;
  error?: string;
  saved?: Saved;
  running?: Collector;
  recent: NodeScoutRun[];
  /** The latest run that brought a list, kept even once `recent` has moved past it. */
  listed?: NodeScoutRun;
  /**
   * The list and setup the last synthesis judged, by digest, and its answer, or why it failed. Kept in memory only, so a
   * restart costs one more call.
   */
  synthesis?: { digest: string; answer?: SynthesisAnswer; reason?: string };
}

const scheduleKey = (manifest: ScoutManifest) => `${manifest.schedule.cron}|${manifest.schedule.timezone}`;

/** The first problem zod found, as `path: message`. */
function firstIssue(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  const issue = error.issues[0];
  if (!issue) return 'it doesn’t match';
  const path = issue.path.map(String).join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

/** A cron that will come round, in a zone that exists, or why not. */
function cronOf(manifest: ScoutManifest): Cron | string {
  const { cron, timezone } = manifest.schedule;
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    return `schedule: "${timezone}" is no time zone this machine knows (try one like "America/Chicago")`;
  }
  let job: Cron;
  try {
    job = new Cron(cron.trim(), { timezone, paused: true, mode: '5-part' });
  } catch (error) {
    return `schedule: "${cron}" isn't a five-field cron: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!job.nextRun()) return `schedule: "${cron}" never comes round`;
  return job;
}

function tail(text: string, max = MAX_SCOUT_STDERR): string {
  return text.length > max ? text.slice(-max) : text;
}

export function createScouts(options: ScoutsOptions): Scouts {
  const { dir, statePath, env, onScouts, onRun } = options;
  const home = options.home ?? homedir();
  const now = options.now ?? Date.now;
  const collect = options.collect ?? spawnCollector;
  const log = options.log ?? ((line: string) => console.error(`[crystal:scouts] ${line}`));

  const entries = new Map<string, Entry>();
  const running = new Set<Promise<void>>();
  // Scripts `run` actions started, stopped by `close` like collectors.
  const acting = new Set<Collector>();
  let saved = readSaved();
  let written = JSON.stringify(saved, null, 2);
  let lastList: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let ticking: Promise<void> | undefined;
  let scanError: string | undefined;

  function readSaved(): Record<string, Saved> {
    try {
      const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null) return {};
      return Object.fromEntries(
        Object.entries(parsed).flatMap(([id, value]) => {
          const one = Saved.safeParse(value);
          return one.success ? [[id, one.data]] : [];
        }),
      );
    } catch {
      return {};
    }
  }

  /** Writes what's kept across restarts, when it changed. A Scout whose scout.json doesn't load yet keeps what it had. */
  function save(): void {
    saved = Object.fromEntries(
      [...entries].flatMap(([id, entry]) => {
        const kept = entry.saved ?? saved[id];
        return kept ? [[id, kept]] : [];
      }),
    );
    const json = JSON.stringify(saved, null, 2);
    if (json === written) return;
    try {
      const temp = `${statePath}.${process.pid}.tmp`;
      writeFileSync(temp, json);
      renameSync(temp, statePath);
      written = json;
    } catch (error) {
      log(`could not save the Scouts' schedule: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The next time a Scout is due after `from`, jitter included. */
  function nextAfter(entry: Entry, from: number): number | undefined {
    const next = entry.cron?.nextRun(new Date(from));
    return next ? next.getTime() + jitterOf(entry.id) : undefined;
  }

  function list(): Scout[] {
    return [...entries.values()].map((entry) => {
      const paused = entry.saved?.paused;
      const nextRunAt = entry.manifest && !paused ? entry.saved?.next : undefined;
      return {
        id: entry.id,
        ...(entry.manifest ? { manifest: entry.manifest } : {}),
        ...(entry.error ? { error: entry.error } : {}),
        ...(paused ? { paused } : {}),
        ...(nextRunAt !== undefined ? { nextRunAt } : {}),
      };
    });
  }

  function announce(): void {
    const scouts = list();
    const json = JSON.stringify(scouts);
    if (json === lastList) return;
    lastList = json;
    onScouts(scouts);
  }

  /** Reads one Scout's `scout.json`, keeping the last good one when the new one doesn't load. */
  function load(entry: Entry): void {
    let text: string;
    try {
      text = readFileSync(join(dir, entry.id, 'scout.json'), 'utf8');
    } catch {
      entry.text = undefined;
      entry.error = 'no scout.json in this folder yet';
      return;
    }
    if (text === entry.text) return;
    entry.text = text;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      entry.error = `scout.json isn't JSON: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    const parsed = ScoutManifest.safeParse(json);
    if (!parsed.success) {
      entry.error = `scout.json: ${firstIssue(parsed.error)}`;
      return;
    }
    const cron = cronOf(parsed.data);
    if (typeof cron === 'string') {
      entry.error = `scout.json: ${cron}`;
      return;
    }
    entry.manifest = parsed.data;
    entry.cron = cron;
    entry.error = undefined;
    const key = scheduleKey(parsed.data);
    const kept = entry.saved ?? saved[entry.id];
    if (kept && kept.schedule === key) {
      const next = kept.next ?? nextAfter(entry, now());
      entry.saved = { ...kept, ...(next !== undefined ? { next } : {}) };
    } else {
      // A new Scout, or a new schedule: it waits for its first time rather than running at once.
      const next = nextAfter(entry, now());
      entry.saved = {
        schedule: key,
        failures: kept?.failures ?? 0,
        ...(kept?.paused ? { paused: kept.paused } : {}),
        ...(next !== undefined ? { next } : {}),
      };
    }
  }

  function scan(): void {
    let names: string[];
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory() && ScoutId.safeParse(dirent.name).success)
        .map((dirent) => dirent.name)
        .sort();
      scanError = undefined;
    } catch (error) {
      // Only a folder that isn't there means no Scouts. Anything else may pass, so nothing is dropped meanwhile.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== scanError) log(`could not read the Scouts folder, keeping the Scouts as they were: ${message}`);
        scanError = message;
        return;
      }
      names = [];
    }
    if (names.length > MAX_SCOUTS) {
      log(`found ${names.length} Scouts; only the first ${MAX_SCOUTS} by name are used`);
      names = names.slice(0, MAX_SCOUTS);
    }
    for (const id of [...entries.keys()]) {
      if (names.includes(id)) continue;
      entries.get(id)?.running?.stop();
      entries.delete(id);
    }
    const fresh = new Map<string, Entry>();
    for (const id of names) {
      const entry = entries.get(id) ?? { id, recent: [] };
      load(entry);
      fresh.set(id, entry);
    }
    entries.clear();
    for (const [id, entry] of fresh) entries.set(id, entry);
  }

  function send(entry: Entry, whole: ScoutRun, items?: ScoutItem[]): void {
    const run =
      whole.reason && whole.reason.length > MAX_REASON
        ? { ...whole, reason: whole.reason.slice(0, MAX_REASON) }
        : whole;
    const frame = { kind: 'scout-run', scout: entry.id, run, ...(items ? { items } : {}) } as NodeScoutRun;
    entry.recent.push(frame);
    if (entry.recent.length > RUNS_KEPT) entry.recent.splice(0, entry.recent.length - RUNS_KEPT);
    if (items) entry.listed = frame;
    onRun(entry.id, run, items);
  }

  function skip(entry: Entry, trigger: string): void {
    const at = now();
    send(entry, {
      id: randomUUID(),
      startedAt: at,
      finishedAt: at,
      trigger,
      outcome: 'skipped',
      reason: 'the last run was still running',
    });
  }

  /** The run's outcome and items from what the collector did. */
  function judge(
    result: CollectResult,
    timeoutMs: number,
  ): { outcome: string; reason?: string; stderr?: string; items?: ScoutItem[] } {
    const stderr = 'stderr' in result && result.stderr ? { stderr: tail(result.stderr) } : {};
    switch (result.kind) {
      case 'not-started':
        return { outcome: 'failed', reason: `could not start the collector: ${result.message}` };
      case 'timed-out':
        return { outcome: 'timed-out', reason: `stopped after ${timeoutMs / 1000} s`, ...stderr };
      case 'too-much':
        return { outcome: 'failed', reason: `printed more than ${MAX_STDOUT / 1024 / 1024} MB`, ...stderr };
      case 'exited': {
        if (result.code !== 0) {
          const how =
            result.code === null ? `was killed by ${result.signal ?? 'a signal'}` : `exited with code ${result.code}`;
          return { outcome: 'failed', reason: `the collector ${how}`, ...stderr };
        }
        let json: unknown;
        try {
          json = JSON.parse(result.stdout);
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error);
          return { outcome: 'failed', reason: `what the collector printed isn't JSON: ${why}`, ...stderr };
        }
        const parsed = ScoutItems.safeParse(json);
        if (!parsed.success) {
          return { outcome: 'failed', reason: `the collector's list: ${firstIssue(parsed.error)}`, ...stderr };
        }
        return { outcome: 'succeeded', items: parsed.data.items.map(withoutSources), ...stderr };
      }
    }
  }

  /** What a Scout's scripts get: the login environment, the Scout's id and state folder, and never the node token. */
  function scriptEnv(id: string, state: string, extra: Record<string, string> = {}): Record<string, string> {
    const childEnv: Record<string, string> = { ...env, CRYSTAL_SCOUT: id, CRYSTAL_SCOUT_STATE: state, ...extra };
    delete childEnv.CRYSTAL_TOKEN;
    return childEnv;
  }

  function begin(entry: Entry, trigger: string): void {
    const manifest = entry.manifest!;
    const startedAt = now();
    const cwd = join(dir, entry.id);
    const state = join(cwd, 'state');
    const timeoutMs = (manifest.collect.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
    try {
      // Private: a collector may keep a token of its own here.
      mkdirSync(state, { recursive: true, mode: 0o700 });
    } catch (error) {
      log(`no state folder for ${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const childEnv = scriptEnv(entry.id, state);
    const collector = collect({ cwd, command: [...manifest.collect.command], env: childEnv, timeoutMs });
    entry.running = collector;
    const done = collector.result
      .catch((error: unknown): CollectResult => ({ kind: 'not-started', message: String(error) }))
      .then(async (result) => {
        // Stopped by `close`, or its folder went: nobody is waiting for this run.
        if (entry.running !== collector || closed) return;
        const judged = judge(result, timeoutMs);
        let { items } = judged;
        let synthesized: { reason?: string; costUsd?: number } = {};
        if (items && items.length > 0 && manifest.synthesize && entries.get(entry.id) === entry) {
          const step = await synthesize(entry, manifest, items, cwd, childEnv, trigger);
          // Stopped by `close` while it thought.
          if (!step || closed) return;
          items = step.items;
          synthesized = step.note;
        }
        entry.running = undefined;
        if (entries.get(entry.id) !== entry) return;
        const { items: _collected, ...verdict } = judged;
        const run: ScoutRun = {
          id: randomUUID(),
          startedAt,
          finishedAt: now(),
          trigger,
          ...verdict,
          ...synthesized,
          ...(items ? { items: items.length } : {}),
        };
        settle(entry, run.outcome);
        send(entry, run, items);
        save();
        announce();
      })
      .finally(() => running.delete(done));
    running.add(done);
  }

  /**
   * The synthesis step, for a list the collector just brought. Runs `claude` only when the list or the step's setup
   * changed since the last synthesis, applying the last answer again otherwise. A failure keeps the plain list, and its
   * reason is repeated on each run until something changes; Run now tries again regardless. While it thinks it holds
   * the Scout's running slot, so `close` stops it and Run now records a skip. Resolves undefined when it was stopped.
   */
  async function synthesize(
    entry: Entry,
    manifest: ScoutManifest,
    items: ScoutItem[],
    cwd: string,
    childEnv: Record<string, string>,
    trigger: string,
  ): Promise<{ items: ScoutItem[]; note: { reason?: string; costUsd?: number } } | undefined> {
    const step = manifest.synthesize!;
    const why = (reason: string) => `not synthesized: ${reason}`.slice(0, MAX_REASON);
    const instructions = scoutFile(entry.id, step.prompt);
    // No call is made, so nothing is kept: the next run reads the file again.
    if (typeof instructions !== 'string') return { items, note: { reason: why(instructions.reason) } };
    const digest = synthesisDigest(items, {
      name: manifest.name,
      instructions,
      synthesize: step,
      actions: manifest.actions,
      defaults: manifest.defaults,
    });
    const last = entry.synthesis;
    if (last?.digest === digest && (last.answer || trigger !== 'now')) {
      if (last.answer) return { items: applySynthesis(items, last.answer, manifest), note: {} };
      return { items, note: last.reason ? { reason: last.reason } : {} };
    }
    const failed = (reason: string, costUsd?: number) => {
      entry.synthesis = { digest, reason: why(reason) };
      return { items, note: { reason: why(reason), ...(costUsd !== undefined ? { costUsd } : {}) } };
    };
    const call = collect({
      cwd,
      command: [
        resolveClaudeBin(childEnv),
        ...synthesisArgs(synthesisSchema(manifest), step.maxBudgetUsd ?? DEFAULT_SYNTHESIS_BUDGET_USD),
      ],
      env: childEnv,
      timeoutMs: SYNTHESIS_TIMEOUT_SECONDS * 1000,
      maxStdout: MAX_SYNTHESIS_STDOUT,
      stdin: synthesisPrompt(instructions, manifest, items),
    });
    entry.running = call;
    const result = await call.result.catch((error: unknown): CollectResult => ({
      kind: 'not-started',
      message: String(error),
    }));
    if (entry.running !== call || closed) return undefined;
    const stderr = 'stderr' in result && result.stderr.trim() ? `: ${tail(result.stderr.trim(), 200)}` : '';
    switch (result.kind) {
      case 'not-started':
        return failed(`could not start claude: ${result.message}`);
      case 'timed-out':
        return failed(`claude was stopped after ${SYNTHESIS_TIMEOUT_SECONDS} s${stderr}`);
      case 'too-much':
        return failed(`claude printed more than ${MAX_SYNTHESIS_STDOUT / 1024 / 1024} MB`);
      case 'exited': {
        // A call the CLI ended itself, such as on the budget cap, still prints a result saying why.
        const read = readSynthesis(result.stdout);
        if (read.ok) {
          entry.synthesis = { digest, answer: read.answer };
          const costUsd = read.costUsd !== undefined ? { costUsd: read.costUsd } : {};
          return { items: applySynthesis(items, read.answer, manifest), note: costUsd };
        }
        if (result.code !== 0 && !result.stdout.trim()) {
          const how =
            result.code === null ? `was killed by ${result.signal ?? 'a signal'}` : `exited with code ${result.code}`;
          return failed(`claude ${how}${stderr}`);
        }
        return failed(read.reason, read.costUsd);
      }
    }
  }

  /** Counts failures, pausing or resuming the schedule. A skip changes nothing. */
  function settle(entry: Entry, outcome: string): void {
    const saved = entry.saved;
    if (!saved || outcome === 'skipped') return;
    if (outcome === 'succeeded') {
      saved.failures = 0;
      if (saved.paused) {
        delete saved.paused;
        const next = nextAfter(entry, now());
        if (next !== undefined) saved.next = next;
      }
      return;
    }
    saved.failures += 1;
    if (saved.failures >= FAILURES_TO_PAUSE && !saved.paused) {
      saved.paused = `stopped after ${saved.failures} failed runs in a row: run it now to try again`;
    }
  }

  function runNow(id: string): void {
    const entry = entries.get(id);
    if (closed) return;
    if (!entry) return log(`asked to run a Scout that isn't here: ${id}`);
    if (!entry.manifest) {
      const at = now();
      send(entry, {
        id: randomUUID(),
        startedAt: at,
        finishedAt: at,
        trigger: 'now',
        outcome: 'failed',
        reason: entry.error ?? 'this Scout has no scout.json that loads',
      });
      return;
    }
    if (entry.running) return skip(entry, 'now');
    begin(entry, 'now');
  }

  /** A file named in `scout.json`, read only from inside the Scout's own folder. */
  function scoutFile(id: string, name: string): string | { reason: string } {
    const folder = join(dir, id);
    const path = resolve(folder, name);
    const inside = relative(folder, path);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) {
      return { reason: `${name} isn't inside the Scout's folder` };
    }
    try {
      if (statSync(path).size > MAX_PROMPT_BYTES) return { reason: `${name} is over ${MAX_PROMPT_BYTES / 1024} KB` };
      return readFileSync(path, 'utf8');
    } catch {
      return { reason: `can't read ${name} in the Scout's folder` };
    }
  }

  function runScript(entry: Entry, key: string, command: string[], items: readonly ScoutItem[]): Promise<ActResult> {
    const cwd = join(dir, entry.id);
    const state = join(cwd, 'state');
    const timeoutMs = ACTION_TIMEOUT_SECONDS * 1000;
    try {
      mkdirSync(state, { recursive: true, mode: 0o700 });
    } catch (error) {
      log(`no state folder for ${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const script = collect({
      cwd,
      command,
      env: scriptEnv(entry.id, state, { CRYSTAL_SCOUT_ACTION: key }),
      timeoutMs,
      maxStdout: MAX_ACTION_STDOUT,
      stdin: JSON.stringify({ scout: entry.id, action: key, items }),
    });
    acting.add(script);
    const answer = script.result
      .catch((error: unknown): CollectResult => ({ kind: 'not-started', message: String(error) }))
      .then((result): ActResult => {
        const stderr = 'stderr' in result && result.stderr.trim() ? `: ${tail(result.stderr.trim(), 500)}` : '';
        switch (result.kind) {
          case 'not-started':
            return { ok: false, reason: `could not start the script: ${result.message}` };
          case 'timed-out':
            return { ok: false, reason: `the script was stopped after ${ACTION_TIMEOUT_SECONDS} s${stderr}` };
          case 'too-much':
            return { ok: false, reason: `the script printed too much${stderr}` };
          case 'exited':
            if (result.code === 0) return { ok: true };
            return {
              ok: false,
              reason: `the script ${result.code === null ? `was killed by ${result.signal ?? 'a signal'}` : `exited with code ${result.code}`}${stderr}`,
            };
        }
      })
      .finally(() => acting.delete(script));
    const done = answer.then(() => {});
    running.add(done);
    void done.finally(() => running.delete(done));
    return answer;
  }

  async function act(
    request: HubScoutAction,
    startQuest: (start: QuestStart) => Promise<ActResult>,
  ): Promise<ActResult> {
    const refuse = (reason: string): ActResult => ({ ok: false, reason });
    if (closed) return refuse('this Kingdom is shutting down');
    const entry = entries.get(request.scout);
    const manifest = entry?.manifest;
    if (!entry || !manifest) return refuse(`this Kingdom has no Scout ${request.scout} that loads`);
    const action = Object.hasOwn(manifest.actions, request.action) ? manifest.actions[request.action] : undefined;
    if (!action) return refuse(`the Scout declares no action ${request.action}`);
    // The hub checks this too; a Kingdom doesn't take its word for it.
    const offered = (item: ScoutItem) => (item.actions ?? manifest.defaults ?? []).includes(request.action);
    if (!request.items.every(offered)) return refuse(`not every item offers ${action.label}`);
    if (action.kind === 'quest') {
      if (request.items.length !== 1) return refuse('a Quest starts from one item at a time');
      const item = request.items[0]!;
      const instructions = scoutFile(entry.id, action.prompt);
      if (typeof instructions !== 'string') return refuse(instructions.reason);
      const project = projectFor(action.project, item, home);
      if ('reason' in project) return refuse(project.reason);
      return startQuest({
        cwd: project.cwd,
        prompt: questPrompt(instructions, manifest.name, item),
        ...(action.mode ? { mode: action.mode } : {}),
        ...(action.worktree ? { worktree: true } : {}),
        from: { scout: entry.id, item: item.id, title: item.title },
      });
    }
    if (action.kind === 'run') {
      if (!action.batch && request.items.length !== 1) return refuse(`${action.label} takes one item at a time`);
      return runScript(entry, request.action, [...action.command], request.items);
    }
    return refuse(`the hub carries out ${action.kind} itself`);
  }

  async function tick(): Promise<void> {
    if (closed) return;
    scan();
    const at = now();
    for (const entry of entries.values()) {
      const saved = entry.saved;
      if (!entry.manifest || !saved || saved.paused || saved.next === undefined || at < saved.next) continue;
      const trigger = at - saved.next > CATCH_UP_AFTER_MS ? 'catch-up' : 'schedule';
      const next = nextAfter(entry, at);
      if (next === undefined) delete saved.next;
      else saved.next = next;
      if (entry.running) skip(entry, trigger);
      else begin(entry, trigger);
    }
    save();
    announce();
  }

  function loop(): void {
    if (closed) return;
    ticking = tick()
      .catch((error: unknown) => log(`a tick failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        ticking = undefined;
        if (closed) return;
        timer = setTimeout(loop, TICK_MS);
        timer.unref?.();
      });
  }

  return {
    list,
    recent: () =>
      [...entries.values()].flatMap((entry) =>
        entry.listed && !entry.recent.includes(entry.listed) ? [entry.listed, ...entry.recent] : entry.recent,
      ),
    runNow,
    act,
    tick,
    async idle() {
      await ticking;
      while (running.size > 0) await Promise.all([...running]);
    },
    start() {
      if (!timer && !ticking) loop();
    },
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      for (const entry of entries.values()) entry.running?.stop();
      for (const script of acting) script.stop();
      // Waits, so a collector that ignores the polite stop is killed before Crystal exits rather than outliving it.
      let cap: NodeJS.Timeout | undefined;
      const capped = new Promise<void>((resolve) => (cap = setTimeout(resolve, KILL_GRACE_MS + PIPE_GRACE_MS)));
      await Promise.race([Promise.all([...running]), capped]);
      clearTimeout(cap);
    },
  };
}

/**
 * Runs a collector as Crystal's own user, in the Scout's folder. On POSIX it gets a process group of its own, so a
 * timeout ends whatever a shell script started too. stdout is kept whole up to a cap; stderr only its end.
 */
export function spawnCollector(request: CollectRequest): Collector {
  const { cwd, command, env, timeoutMs, maxStdout = MAX_STDOUT, stdin } = request;
  const [file, ...args] = command;
  const posix = process.platform !== 'win32';
  let stop: () => void = () => {};

  const result = new Promise<CollectResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file!, args, {
        cwd,
        env,
        detached: posix,
        windowsHide: true,
        stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ kind: 'not-started', message: error instanceof Error ? error.message : String(error) });
      return;
    }
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let ended: 'timed-out' | 'too-much' | undefined;
    let settled = false;
    let grace: NodeJS.Timeout | undefined;

    const finish = (value: CollectResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolve(value);
    };

    const signal = (name: NodeJS.Signals) => {
      try {
        if (posix && child.pid) process.kill(-child.pid, name);
        // Windows has no process groups: taskkill ends the tree under the collector.
        else if (child.pid)
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on(
            'error',
            () => child.kill(),
          );
        else child.kill(name);
      } catch {
        // Already gone.
      }
    };

    /** Asks politely, then kills the lot; a grandchild holding the pipes open can't keep the run going forever. */
    const end = (why?: 'timed-out' | 'too-much') => {
      ended ??= why;
      signal('SIGTERM');
      grace ??= setTimeout(() => {
        signal('SIGKILL');
        // The pipes may never close if something outside the group holds them.
        grace = setTimeout(() => finishEnded(null, 'SIGKILL'), 1_000);
        grace.unref?.();
      }, KILL_GRACE_MS);
      grace.unref?.();
    };

    const finishEnded = (code: number | null, sig: NodeJS.Signals | null) => {
      if (ended) finish({ kind: ended, stderr: tail(stderr) });
      else
        finish({
          kind: 'exited',
          code,
          signal: sig,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: tail(stderr),
        });
    };

    const timer = setTimeout(() => end('timed-out'), timeoutMs);
    timer.unref?.();
    stop = () => end();

    if (stdin !== undefined && child.stdin) {
      // A script that never reads its stdin closes the pipe early; that's its business, not an error here.
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
    }

    child.stdout!.on('data', (chunk: Buffer) => {
      if (ended) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdout) return end('too-much');
      stdout.push(chunk);
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      stderr = tail(stderr + chunk);
    });
    child.on('error', (error) => finish({ kind: 'not-started', message: error.message }));
    // Whatever it left running would hold the pipes open and keep the run going until the timeout.
    child.on('exit', (code, sig) => {
      if (posix && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // Nothing left.
        }
      }
      const pipes = setTimeout(() => finishEnded(code, sig), PIPE_GRACE_MS);
      pipes.unref?.();
    });
    child.on('close', (code, sig) => finishEnded(code, sig));
  });

  return { result, stop: () => stop() };
}
