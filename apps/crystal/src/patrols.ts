import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  MAX_PATROL_OUTPUT,
  MAX_PATROL_PROMPT,
  PatrolId,
  PatrolManifest,
  PatrolRun,
  type Effort,
  type Engine,
  type NodePatrolRun,
  type Patrol,
  type PatrolChangeRequest,
  type PatrolLink,
  type PermissionMode,
} from '@crystal-bridge/protocol';
import { recurrenceOf, scheduleKey, type Recurrence } from './recurrence.js';
import { checkedFolder } from './scout-actions.js';
import { jitterOf, spawnCollector, type CollectRequest, type CollectResult, type Collector } from './scouts.js';

/**
 * Patrols (docs/PATROLS.md): each folder under the Kingdom's patrols folder holds a `patrol.json` that runs a Quest or a
 * script on a schedule. This module finds them, starts each run when it's due, and hands every run to the hub link,
 * once when it sets out and again when it ends. It shares the Scouts' run rules, plus a catch-up window and a pause by
 * hand. A Quest runs as any other Quest does, through `startQuest`; the node link says how its first turn ended.
 */

/** Failed runs in a row (`failed` or `timed-out`) that stand a Patrol down. */
export const FAILURES_TO_STAND_DOWN = 3;
/** How long a script may run when `patrol.json` doesn't say. */
export const DEFAULT_SCRIPT_TIMEOUT_SECONDS = 600;
/** How late a missed run may still catch up when `patrol.json` doesn't say. */
export const DEFAULT_CATCH_UP_MS = 6 * 60 * 60_000;
/** How long a permission prompt in a Patrol's Quest waits for someone when `patrol.json` doesn't say. */
export const DEFAULT_WAIT_FOR_YOU_MS = 30 * 60_000;
/** A due run found later than this was missed (the machine slept, or Crystal was down); earlier counts as on time. */
const ON_TIME_MS = 2 * 60_000;
/** Runs kept per Patrol to send again after a reconnect; the hub keeps the latest of each. */
const RUNS_KEPT = 5;
/** The most Patrols a Kingdom reports, as `NodePatrols` allows. */
const MAX_PATROLS = 100;
/** How often the folder is read again and due runs started. A wall-clock check, so a sleep is noticed on waking. */
const TICK_MS = 10_000;
/** More than any script's output needs before its end is kept. */
const MAX_STDOUT = 32 * 1024 * 1024;
/** Slots looked through to find the latest one missed, after a long sleep. */
const MAX_MISSED_SLOTS = 100_000;
/** How long a stopped script gets before `close` stops waiting. */
const CLOSE_WAIT_MS = 7_000;
const MAX_REASON = 2000;
/** Where deleted Patrols' folders go, so a delete from the app never loses a file someone wrote. */
const DELETED = '.deleted';

/** A Quest a Patrol starts, the way New Quest starts one. Unset fields take the Kingdom's defaults. */
export interface PatrolQuestStart {
  cwd: string;
  prompt: string;
  mode?: PermissionMode;
  effort?: Effort;
  engine?: Engine;
  worktree?: boolean;
  /** The Quest's session id, chosen here so an end that comes while it's still starting finds its run. */
  session: string;
  /** The run it's for, so the Quest links back to it. */
  link: PatrolLink;
  /** How long a permission prompt waits before the turn ends as `needs-you`. */
  waitForYouMs: number;
}

/** How a Patrol's Quest's first turn ended, as the node link saw it. */
export interface QuestEnded {
  outcome: 'finished' | 'failed' | 'needs-you';
  reason?: string;
}

export type ChangeResult = { ok: true } | { ok: false; reason: string };

export interface PatrolsOptions {
  /** The folder holding one folder per Patrol. */
  dir: string;
  /** Where `~` in a Quest Patrol's project points; default the user's home folder. */
  home?: string;
  /** Where each Patrol's next run, failures, pause and run still out are kept across restarts. */
  statePath: string;
  /** The environment scripts get: the sessions' login environment, without the node token. */
  env: Record<string, string>;
  /** Whether the app may save Patrols here (`CRYSTAL_PATROLS_FROM_APP`). Pausing, resuming and deleting always work. */
  fromApp: () => boolean;
  /** Runs a script; `spawnCollector` in production. */
  collect?: (request: CollectRequest) => Collector;
  /** Starts a Patrol's Quest through the node link, or says why it couldn't. */
  startQuest(start: PatrolQuestStart): Promise<{ ok: true } | { ok: false; reason: string }>;
  now?: () => number;
  /** The Patrols changed: their list, a definition, an error, a pause or a next run. */
  onPatrols(patrols: Patrol[]): void;
  /** A run set out or ended. */
  onRun(patrol: string, run: PatrolRun): void;
  log?: (line: string) => void;
}

export interface Patrols {
  /** The Patrols as the hub should see them. */
  list(): Patrol[];
  /** Each Patrol's latest runs, oldest first, to send again after a reconnect (after the list). */
  recent(): NodePatrolRun[];
  /** Runs a Patrol at once, even one stood down, or records a skip if its last run is still out. */
  runNow(id: string): void;
  /** Carries out a change the app asked for. */
  change(id: string, change: PatrolChangeRequest): Promise<ChangeResult>;
  /** A Patrol's Quest's first turn ended. Anything later in that Quest is the user's, not the run's. */
  questEnded(session: string, ended: QuestEnded): void;
  /** Reads the folder again and starts any run that's due. Runs on a timer after `start`. */
  tick(): Promise<void>;
  /** Resolves once no script is running and no Quest is starting. */
  idle(): Promise<void>;
  start(): void;
  /** Stops the timer and every running script. Runs still out are ended on the next start. */
  close(): Promise<void>;
}

/**
 * What's kept across restarts, per Patrol. `schedule` is the schedule key `next` was worked out for. `out` is a run that
 * set out and hasn't ended, so a restart can say it ended. Read leniently, as Scouts' state is.
 */
const Saved = z.object({
  schedule: z.string(),
  next: z.number().int().optional().catch(undefined),
  failures: z.number().int().nonnegative().catch(0),
  paused: z.string().optional().catch(undefined),
  /** Who paused it: by hand stays through a run that works; after failures, a run that works ends it. */
  pausedBy: z.enum(['hand', 'failures']).optional().catch(undefined),
  out: PatrolRun.optional().catch(undefined),
});
type Saved = z.infer<typeof Saved>;

interface Entry {
  id: string;
  manifest?: PatrolManifest;
  recurrence?: Recurrence;
  text?: string;
  error?: string;
  saved?: Saved;
  /** The run still out, and what ends it: a script, or a Quest's session once it has started. */
  out?: { run: PatrolRun; script?: Collector; session?: string };
  recent: NodePatrolRun[];
}

const DURATION_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** `30m`, `6h` or `2d` in milliseconds. */
/** Why a late run was recorded as missed rather than run. */
function missedWhy(catchUp: string | undefined): string {
  return catchUp === 'never'
    ? 'it was late (the Kingdom was asleep or Crystal was down), and catchUp is never'
    : `it was more than ${catchUp ?? '6h'} late, its catchUp window: the Kingdom was asleep or Crystal was down`;
}

export function durationMs(text: string): number {
  const unit = text.slice(-1) as keyof typeof DURATION_MS;
  return Number(text.slice(0, -1)) * DURATION_MS[unit];
}

function firstIssue(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  const issue = error.issues[0];
  if (!issue) return 'it doesn’t match';
  const path = issue.path.map(String).join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const tail = (text: string) => (text.length > MAX_PATROL_OUTPUT ? text.slice(-MAX_PATROL_OUTPUT) : text);

/** Writes a file whole or not at all. */
function writeWhole(path: string, text: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}

export function createPatrols(options: PatrolsOptions): Patrols {
  const { dir, statePath, env, onPatrols, onRun, startQuest } = options;
  const home = options.home ?? homedir();
  const now = options.now ?? Date.now;
  const collect = options.collect ?? spawnCollector;
  const log = options.log ?? ((line: string) => console.error(`[crystal:patrols] ${line}`));

  const entries = new Map<string, Entry>();
  const working = new Set<Promise<void>>();
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
    } catch (error) {
      // No file yet is a first start. Anything else loses pauses and failure counts, so it's said.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        log(`could not read the Patrols' state, starting afresh: ${messageOf(error)}`);
      return {};
    }
  }

  /** Writes what's kept across restarts. A Patrol whose folder is away for now keeps its state; a delete clears it. */
  function save(): void {
    saved = {
      ...saved,
      ...Object.fromEntries(
        [...entries].flatMap(([id, entry]) => {
          const kept = entry.saved ?? saved[id];
          return kept ? [[id, kept]] : [];
        }),
      ),
    };
    const json = JSON.stringify(saved, null, 2);
    if (json === written) return;
    try {
      writeWhole(statePath, json);
      written = json;
    } catch (error) {
      log(`could not save the Patrols' schedule: ${messageOf(error)}`);
    }
  }

  /** The next time a Patrol is due after `from`, jitter included. A schedule the engine can't follow shows as its error. */
  function nextAfter(entry: Entry, from: number): number | undefined {
    try {
      const next = entry.recurrence?.next(from);
      return next === undefined ? undefined : next + jitterOf(entry.id);
    } catch (error) {
      entry.error = `patrol.json: schedule: ${messageOf(error)}`;
      return undefined;
    }
  }

  function list(): Patrol[] {
    return [...entries.values()].map((entry) => {
      const kept = entry.saved;
      const paused = kept?.paused;
      const nextRunAt = entry.manifest && !paused ? kept?.next : undefined;
      return {
        id: entry.id,
        ...(entry.manifest ? { manifest: entry.manifest } : {}),
        ...(entry.error ? { error: entry.error } : {}),
        ...(paused ? { paused } : {}),
        ...(nextRunAt !== undefined ? { nextRunAt } : {}),
        ...(kept?.failures ? { failures: kept.failures } : {}),
      };
    });
  }

  function announce(): void {
    const patrols = list();
    const json = JSON.stringify(patrols);
    if (json === lastList) return;
    lastList = json;
    onPatrols(patrols);
  }

  /** Reads one Patrol's `patrol.json`, keeping the last good one when the new one doesn't load. */
  function load(entry: Entry): void {
    let text: string;
    try {
      text = readFileSync(join(dir, entry.id, 'patrol.json'), 'utf8');
    } catch {
      entry.text = undefined;
      entry.error = 'no patrol.json in this folder yet';
      return;
    }
    if (text === entry.text) return;
    entry.text = text;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      entry.error = `patrol.json isn't JSON: ${messageOf(error)}`;
      return;
    }
    const parsed = PatrolManifest.safeParse(json);
    if (!parsed.success) {
      entry.error = `patrol.json: ${firstIssue(parsed.error)}`;
      return;
    }
    const recurrence = recurrenceOf(parsed.data.schedule);
    if (typeof recurrence === 'string') {
      entry.error = `patrol.json: ${recurrence}`;
      return;
    }
    entry.manifest = parsed.data;
    entry.recurrence = recurrence;
    entry.error = undefined;
    const key = scheduleKey(parsed.data.schedule);
    const kept = entry.saved ?? saved[entry.id];
    if (kept && kept.schedule === key) {
      const next = kept.next ?? nextAfter(entry, now());
      entry.saved = { ...kept, ...(next !== undefined ? { next } : {}) };
    } else {
      // A new Patrol, or a new schedule: it waits for its first time rather than running at once.
      const next = nextAfter(entry, now());
      const { next: _old, schedule: _key, ...rest } = kept ?? { failures: 0 };
      entry.saved = { schedule: key, ...rest, failures: rest.failures ?? 0, ...(next !== undefined ? { next } : {}) };
    }
  }

  function scan(): void {
    let names: string[];
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory() && PatrolId.safeParse(dirent.name).success)
        .map((dirent) => dirent.name)
        .sort();
      scanError = undefined;
    } catch (error) {
      // Only a folder that isn't there means no Patrols. Anything else may pass, so nothing is dropped meanwhile.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        const message = messageOf(error);
        if (message !== scanError)
          log(`could not read the Patrols folder, keeping the Patrols as they were: ${message}`);
        scanError = message;
        return;
      }
      names = [];
    }
    if (names.length > MAX_PATROLS) {
      log(`found ${names.length} Patrols; only the first ${MAX_PATROLS} by name are used`);
      names = names.slice(0, MAX_PATROLS);
    }
    for (const [id, entry] of [...entries]) {
      if (names.includes(id)) continue;
      letGo(entry, 'its folder went away');
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

  /** Reports a run, keeping its latest state among the Patrol's recent runs. */
  function send(entry: Entry, whole: PatrolRun): void {
    const run =
      whole.reason && whole.reason.length > MAX_REASON
        ? { ...whole, reason: whole.reason.slice(0, MAX_REASON) }
        : whole;
    const frame: NodePatrolRun = { kind: 'patrol-run', patrol: entry.id, run };
    const at = entry.recent.findIndex((one) => one.run.id === run.id);
    if (at >= 0) entry.recent.splice(at, 1);
    entry.recent.push(frame);
    if (entry.recent.length > RUNS_KEPT) entry.recent.splice(0, entry.recent.length - RUNS_KEPT);
    onRun(entry.id, run);
  }

  /** A run that never set out: skipped or missed. */
  function record(entry: Entry, trigger: string, outcome: string, reason: string, scheduledAt?: number): void {
    const at = now();
    send(entry, {
      id: randomUUID(),
      ...(scheduledAt !== undefined ? { scheduledAt } : {}),
      startedAt: at,
      finishedAt: at,
      trigger,
      outcome,
      reason,
    });
  }

  /** Counts failures, standing the Patrol down or putting it back. Other outcomes change nothing. */
  function settle(entry: Entry, outcome: string): void {
    const kept = entry.saved;
    if (!kept) return;
    if (outcome === 'finished') {
      kept.failures = 0;
      if (kept.paused && kept.pausedBy !== 'hand') {
        delete kept.paused;
        delete kept.pausedBy;
        // A one-off or a rule that ended while it was down has no next time left: it doesn't run again.
        const next = nextAfter(entry, now());
        if (next === undefined) delete kept.next;
        else kept.next = next;
      }
      return;
    }
    if (outcome !== 'failed' && outcome !== 'timed-out') return;
    kept.failures += 1;
    if (kept.failures >= FAILURES_TO_STAND_DOWN && !kept.paused) {
      kept.paused = `stood down after ${kept.failures} failed runs in a row: run it now to try again`;
      kept.pausedBy = 'failures';
    }
  }

  /**
   * A Patrol that's going while a run is out: the run ends now, before the list drops the Patrol (the hub keeps runs
   * only for Patrols it lists). A script stops; a Quest carries on as the user's own.
   */
  function letGo(entry: Entry, why: string): void {
    const out = entry.out;
    if (!out) return;
    entry.out = undefined;
    if (entry.saved) delete entry.saved.out;
    out.script?.stop();
    send(entry, {
      ...out.run,
      outcome: 'failed',
      finishedAt: now(),
      reason: out.session
        ? `${why} while this run was out; its Quest carries on as an ordinary Quest`
        : `${why} while this run was out, so the script was stopped`,
    });
  }

  /** Ends the run still out with its outcome, if it's the one asked about. */
  function end(entry: Entry, runId: string, ending: Partial<PatrolRun> & { outcome: string }): void {
    // Whatever ends while Crystal stops was ended by the stopping: the run stays out, and the next start says so.
    if (closed || !entry.out || entry.out.run.id !== runId) return;
    const run: PatrolRun = { ...entry.out.run, ...ending, finishedAt: now() };
    entry.out = undefined;
    if (entry.saved) delete entry.saved.out;
    if (entries.get(entry.id) !== entry) return;
    settle(entry, run.outcome);
    send(entry, run);
    save();
    announce();
  }

  /** Marks a run as out, kept across a restart; `told` sends it to the hub too. */
  function setOut(entry: Entry, run: PatrolRun, told = true): void {
    entry.out = { ...entry.out, run };
    if (entry.saved) entry.saved.out = run;
    if (told) send(entry, run);
    save();
  }

  function begin(entry: Entry, trigger: string, scheduledAt?: number): void {
    const manifest = entry.manifest!;
    const run: PatrolRun = {
      id: randomUUID(),
      ...(scheduledAt !== undefined ? { scheduledAt } : {}),
      startedAt: now(),
      trigger,
      outcome: 'running',
    };
    if (manifest.script) beginScript(entry, run, manifest.script);
    else if (manifest.quest) beginQuest(entry, run, manifest.quest);
  }

  function beginScript(entry: Entry, run: PatrolRun, script: NonNullable<PatrolManifest['script']>): void {
    const timeoutMs = (script.timeoutSeconds ?? DEFAULT_SCRIPT_TIMEOUT_SECONDS) * 1000;
    const childEnv: Record<string, string> = { ...env, CRYSTAL_PATROL: entry.id, CRYSTAL_PATROL_RUN: run.id };
    delete childEnv.CRYSTAL_TOKEN;
    setOut(entry, run);
    const collector = collect({
      cwd: join(dir, entry.id),
      command: [...script.command],
      env: childEnv,
      timeoutMs,
      maxStdout: MAX_STDOUT,
    });
    entry.out!.script = collector;
    const done = collector.result
      .catch((error: unknown): CollectResult => ({ kind: 'not-started', message: String(error) }))
      .then((result) => {
        // Stopped by `close`: the next start ends it.
        if (closed) return;
        end(entry, run.id, judge(result, timeoutMs));
      })
      .finally(() => working.delete(done));
    working.add(done);
  }

  function judge(result: CollectResult, timeoutMs: number): Partial<PatrolRun> & { outcome: string } {
    const stderr = 'stderr' in result && result.stderr ? { stderr: tail(result.stderr) } : {};
    switch (result.kind) {
      case 'not-started':
        return { outcome: 'failed', reason: `could not start the script: ${result.message}` };
      case 'timed-out':
        return { outcome: 'timed-out', reason: `stopped after ${timeoutMs / 1000} s`, ...stderr };
      case 'too-much':
        return { outcome: 'failed', reason: 'the script wrote more than a run keeps', ...stderr };
      case 'exited': {
        const stdout = result.stdout ? { stdout: tail(result.stdout) } : {};
        const code = result.code === null ? {} : { exitCode: result.code };
        if (result.code === 0) return { outcome: 'finished', ...code, ...stdout, ...stderr };
        const how = result.code === null ? `was ended by ${result.signal ?? 'a signal'}` : `exited with ${result.code}`;
        return { outcome: 'failed', reason: `the script ${how}`, ...code, ...stdout, ...stderr };
      }
    }
  }

  /** The prompt a Quest Patrol gives: its text, or its prompt file's. */
  function promptOf(
    entry: Entry,
    quest: NonNullable<PatrolManifest['quest']>,
  ): { prompt: string } | { reason: string } {
    if (quest.promptText !== undefined) return { prompt: quest.promptText };
    let text: string;
    try {
      text = readFileSync(join(dir, entry.id, quest.prompt!), 'utf8');
    } catch (error) {
      return { reason: `could not read the prompt file ${quest.prompt}: ${messageOf(error)}` };
    }
    if (text.trim() === '') return { reason: `the prompt file ${quest.prompt} is empty` };
    if (text.length > MAX_PATROL_PROMPT)
      return { reason: `the prompt file ${quest.prompt} is longer than ${MAX_PATROL_PROMPT} characters` };
    return { prompt: text };
  }

  function beginQuest(entry: Entry, run: PatrolRun, quest: NonNullable<PatrolManifest['quest']>): void {
    // Told to the hub once its Quest has started, so the run links to it from the first frame.
    setOut(entry, run, false);
    const folder = checkedFolder(quest.project, home);
    const prompt = 'reason' in folder ? folder : promptOf(entry, quest);
    if ('reason' in folder || 'reason' in prompt) {
      end(entry, run.id, {
        outcome: 'failed',
        reason: 'reason' in folder ? folder.reason : (prompt as { reason: string }).reason,
      });
      return;
    }
    // Known before the Quest starts, so an end that comes while it's starting still finds this run.
    const session = randomUUID();
    const withQuest: PatrolRun = { ...run, session };
    setOut(entry, withQuest, false);
    entry.out!.session = session;
    const start: PatrolQuestStart = {
      cwd: folder.cwd,
      prompt: prompt.prompt,
      ...(quest.mode ? { mode: quest.mode } : {}),
      ...(quest.effort ? { effort: quest.effort } : {}),
      ...(quest.engine ? { engine: quest.engine } : {}),
      ...(quest.worktree ? { worktree: true } : {}),
      session,
      link: { patrol: entry.id, run: run.id },
      waitForYouMs: quest.waitForYou ? durationMs(quest.waitForYou) : DEFAULT_WAIT_FOR_YOU_MS,
    };
    const done = startQuest(start)
      .catch((error: unknown) => ({ ok: false as const, reason: `the Quest did not start: ${messageOf(error)}` }))
      .then((started) => {
        if (closed || entry.out?.run.id !== run.id) return;
        if (!started.ok) {
          end(entry, run.id, { outcome: 'failed', reason: started.reason });
          return;
        }
        send(entry, withQuest);
      })
      .finally(() => working.delete(done));
    working.add(done);
  }

  function questEnded(session: string, ended: QuestEnded): void {
    for (const entry of entries.values()) {
      if (entry.out?.session !== session) continue;
      end(entry, entry.out.run.id, { outcome: ended.outcome, ...(ended.reason ? { reason: ended.reason } : {}) });
      return;
    }
  }

  function runNow(id: string): void {
    const entry = entries.get(id);
    if (!entry?.manifest || closed) return;
    if (entry.out) record(entry, 'now', 'skipped', 'the last run was still out');
    else begin(entry, 'now');
    announce();
  }

  /**
   * Runs that were out when Crystal stopped: they ended then, and nothing will say how. Not counted as failures. Checked
   * on every tick, so a Patrol that only loads later still has its run ended.
   */
  function endLeftOut(): void {
    for (const entry of entries.values()) {
      const out = entry.saved?.out;
      if (!out || entry.out) continue;
      delete entry.saved!.out;
      send(entry, {
        ...out,
        outcome: 'failed',
        finishedAt: now(),
        reason: out.session
          ? 'Crystal stopped while this run was out; its Quest can be carried on from its session'
          : 'Crystal stopped while this run was out',
      });
    }
  }

  async function tick(): Promise<void> {
    if (closed) return;
    scan();
    endLeftOut();
    const at = now();
    for (const entry of entries.values()) {
      const kept = entry.saved;
      if (!entry.manifest || !kept || kept.paused || kept.next === undefined || at < kept.next) continue;
      // The latest time it was due: a sleep across several of them sets out once at most.
      let slot = kept.next;
      for (let step = 0; step < MAX_MISSED_SLOTS; step++) {
        const later = nextAfter(entry, slot);
        if (later === undefined || later > at) break;
        slot = later;
      }
      const next = nextAfter(entry, at);
      if (next === undefined) delete kept.next;
      else kept.next = next;
      const late = at - slot;
      const catchUp = entry.manifest.catchUp ?? DEFAULT_CATCH_UP_MS;
      const window = catchUp === 'never' ? 0 : typeof catchUp === 'number' ? catchUp : durationMs(catchUp);
      const trigger = late > ON_TIME_MS ? 'catch-up' : 'schedule';
      if (late > ON_TIME_MS && late > window) {
        record(entry, 'schedule', 'missed', missedWhy(entry.manifest.catchUp), slot);
      } else if (entry.out) {
        record(entry, trigger, 'skipped', 'the last run was still out', slot);
      } else {
        begin(entry, trigger, slot);
      }
    }
    save();
    announce();
  }

  async function change(id: string, request: PatrolChangeRequest): Promise<ChangeResult> {
    if (closed) return { ok: false, reason: 'Crystal is shutting down' };
    scan();
    if (request.op === 'save') return saveFromApp(id, request.manifest, request.prompt);
    const entry = entries.get(id);
    if (!entry) return { ok: false, reason: `no Patrol "${id}" on this Kingdom` };
    if (request.op === 'delete') {
      // Moved first: if it can't be, nothing else changes.
      try {
        mkdirSync(join(dir, DELETED), { recursive: true });
        renameSync(join(dir, id), join(dir, DELETED, `${id}-${new Date(now()).toISOString().replace(/[:.]/g, '-')}`));
      } catch (error) {
        return { ok: false, reason: `could not delete it: ${messageOf(error)}` };
      }
      letGo(entry, 'the Patrol was deleted');
      entries.delete(id);
      delete saved[id];
    } else if (!entry.saved) {
      return { ok: false, reason: entry.error ?? 'its patrol.json has never loaded' };
    } else if (request.op === 'pause') {
      entry.saved.paused = 'paused by hand';
      entry.saved.pausedBy = 'hand';
    } else {
      delete entry.saved.paused;
      delete entry.saved.pausedBy;
      entry.saved.failures = 0;
      // From now: what it missed while paused isn't caught up.
      const next = nextAfter(entry, now());
      if (next === undefined) delete entry.saved.next;
      else entry.saved.next = next;
    }
    save();
    announce();
    return { ok: true };
  }

  /** Writes a Patrol the app sent, after the checks a file would get and the app's own limits. */
  function saveFromApp(id: string, body: unknown, prompt: string | undefined): ChangeResult {
    if (!options.fromApp()) return { ok: false, reason: 'this Kingdom takes Patrols only from files' };
    if (!PatrolId.safeParse(id).success) return { ok: false, reason: `"${id}" can't name a Patrol` };
    const parsed = PatrolManifest.safeParse(body);
    if (!parsed.success) return { ok: false, reason: firstIssue(parsed.error) };
    const manifest = parsed.data;
    if (manifest.script || !manifest.quest)
      return { ok: false, reason: 'the app saves Quest Patrols only; a script Patrol is written on its Kingdom' };
    const folder = join(dir, id);
    // A script Patrol is never replaced from the app, even while its file doesn't load: only a folder with no
    // patrol.json, or one that loads as a Quest Patrol, may be saved over.
    if (entries.get(id)?.manifest?.script)
      return { ok: false, reason: 'a script Patrol is changed only in its file on the Kingdom' };
    let onDisk: string | undefined;
    try {
      onDisk = readFileSync(join(folder, 'patrol.json'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        return { ok: false, reason: `could not read its patrol.json: ${messageOf(error)}` };
    }
    if (onDisk !== undefined) {
      let current: PatrolManifest | undefined;
      try {
        const loaded = PatrolManifest.safeParse(JSON.parse(onDisk));
        if (loaded.success) current = loaded.data;
      } catch {
        // Not JSON: refused below.
      }
      if (!current) return { ok: false, reason: 'its patrol.json doesn’t load: fix or remove it on the Kingdom first' };
      if (current.script) return { ok: false, reason: 'a script Patrol is changed only in its file on the Kingdom' };
    }
    const recurrence = recurrenceOf(manifest.schedule);
    if (typeof recurrence === 'string') return { ok: false, reason: recurrence };
    const project = checkedFolder(manifest.quest.project, home);
    if ('reason' in project) return { ok: false, reason: project.reason };
    const promptFile = manifest.quest.prompt;
    if (promptFile && prompt === undefined) {
      try {
        if (!statSync(join(folder, promptFile)).isFile()) throw new Error('not a file');
      } catch {
        return { ok: false, reason: `send the prompt with it: there's no ${promptFile} in the Patrol's folder` };
      }
    }
    try {
      mkdirSync(folder, { recursive: true });
      if (promptFile && prompt !== undefined) writeWhole(join(folder, promptFile), prompt);
      writeWhole(join(folder, 'patrol.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    } catch (error) {
      return { ok: false, reason: `could not write it: ${messageOf(error)}` };
    }
    scan();
    save();
    announce();
    return { ok: true };
  }

  function loop(): void {
    if (closed) return;
    ticking = tick()
      .catch((error: unknown) => log(`a tick failed: ${messageOf(error)}`))
      .finally(() => {
        ticking = undefined;
        if (closed) return;
        timer = setTimeout(loop, TICK_MS);
        timer.unref?.();
      });
  }

  return {
    list,
    recent: () => [...entries.values()].flatMap((entry) => entry.recent),
    runNow,
    change,
    questEnded,
    tick,
    async idle() {
      await ticking;
      while (working.size > 0) await Promise.all([...working]);
    },
    start() {
      if (!timer && !ticking) loop();
    },
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      save();
      for (const entry of entries.values()) entry.out?.script?.stop();
      let cap: NodeJS.Timeout | undefined;
      const capped = new Promise<void>((resolve) => (cap = setTimeout(resolve, CLOSE_WAIT_MS)));
      await Promise.race([Promise.all([...working]), capped]);
      clearTimeout(cap);
    },
  };
}
