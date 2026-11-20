import { z } from 'zod';
import { Effort, Engine, PermissionMode } from './mode.js';
import { ScoutId } from './scouts.js';

/**
 * Patrols (docs/PATROLS.md): a Patrol is a scheduled job on a Kingdom that runs a Quest from a saved prompt, or a script,
 * at the times its recurrence rule gives. Nothing here is engine-specific; a Quest's output stays in its own events.
 */

/** A Patrol's folder name under `~/.crystal-bridge/patrols/`, which is also its id. Safe as a path segment and a URL part. */
export const PatrolId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export type PatrolId = z.infer<typeof PatrolId>;

/** A length of time such as `30m`, `6h` or `2d`. */
export const PatrolDuration = z.string().regex(/^[1-9][0-9]{0,4}[smhd]$/);
export type PatrolDuration = z.infer<typeof PatrolDuration>;

const timezone = z.string().min(1).max(64);
/** A local date-time in the schedule's time zone, such as `2026-12-01T09:00`; the Kingdom's engine reads it (#281). */
const localTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/);
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * When a Patrol sets out: an RFC 5545 recurrence rule from a start, five-field cron, or a single time, each with the time
 * zone it means. Only the shape is checked here; whether a rule makes sense is the recurrence engine's call (#281).
 * Each form is strict, so a schedule naming two forms, or a form this hub doesn't know, fails its Patrol alone.
 */
export const PatrolSchedule = z.union([
  z.strictObject({
    rule: z
      .string()
      .max(500)
      .regex(/(^|[:;])FREQ=/),
    start: localTime,
    timezone,
    /** Days the rule would give that are skipped. */
    except: z
      .array(z.union([localDate, localTime]))
      .max(366)
      .optional(),
  }),
  z.strictObject({
    cron: z
      .string()
      .max(200)
      .regex(/^\s*\S+(\s+\S+){4}\s*$/),
    timezone,
  }),
  z.strictObject({ once: localTime, timezone }),
]);
export type PatrolSchedule = z.infer<typeof PatrolSchedule>;

/**
 * A file in the Patrol's folder, such as a prompt: a plain name, so it can't reach outside the folder. Never
 * `patrol.json` (in any case, for case-insensitive disks) or a dot-file, so prompt text saved from the app can't
 * replace the manifest or a hidden file beside it.
 */
const patrolFile = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^/\\.][^/\\]*$/)
  .refine((name) => name.toLowerCase() !== 'patrol.json', { message: 'a file in the Patrol folder' });

/** The longest prompt a Patrol carries in `patrol.json` or sends from the app. */
export const MAX_PATROL_PROMPT = 20_000;

/** A Quest Patrol: what New Quest takes. Unset fields take the Kingdom's defaults. */
export const PatrolQuest = z
  .object({
    project: z.string().min(1).max(4096),
    /** A prompt file in the Patrol's folder. */
    prompt: patrolFile.optional(),
    /** The prompt itself, for a Patrol made in the app. */
    promptText: z.string().min(1).max(MAX_PATROL_PROMPT).optional(),
    mode: PermissionMode.optional(),
    effort: Effort.optional(),
    engine: Engine.optional(),
    worktree: z.boolean().optional(),
    /** How long a permission prompt waits for you before the run ends as `needs-you`. */
    waitForYou: PatrolDuration.optional(),
  })
  .refine((quest) => (quest.prompt === undefined) !== (quest.promptText === undefined), {
    message: 'a Quest Patrol has exactly one of `prompt` and `promptText`',
  });
export type PatrolQuest = z.infer<typeof PatrolQuest>;

/** A script Patrol: a command run in the Patrol's folder as Crystal's user, without the node token. */
export const PatrolScript = z.object({
  command: z.array(z.string().max(4096)).min(1).max(64),
  timeoutSeconds: z.number().int().min(1).max(86_400).optional(),
});
export type PatrolScript = z.infer<typeof PatrolScript>;

/**
 * `patrol.json`. Fields a newer Kingdom adds are dropped. A value this hub doesn't know, such as a new schedule form,
 * fails this Patrol alone: `NodePatrols` keeps it as an error and keeps the Kingdom's other Patrols.
 */
export const PatrolManifest = z
  .object({
    name: z.string().min(1).max(80),
    schedule: PatrolSchedule,
    quest: PatrolQuest.optional(),
    script: PatrolScript.optional(),
    /** A Scout whose Board this Patrol posts its runs to. */
    board: ScoutId.optional(),
    /** How late a missed run may still catch up; `never` records it as missed. The Kingdom's default when unset. */
    catchUp: z.union([PatrolDuration, z.literal('never')]).optional(),
  })
  .refine((manifest) => (manifest.quest === undefined) !== (manifest.script === undefined), {
    message: 'a Patrol has exactly one of `quest` and `script`',
  });
export type PatrolManifest = z.infer<typeof PatrolManifest>;

/** A Patrol as its Kingdom reports it: the last good `patrol.json`, and why the current one doesn't load, if it doesn't. */
export const Patrol = z.object({
  id: PatrolId,
  /** Absent for a Patrol whose `patrol.json` has never loaded. */
  manifest: PatrolManifest.optional(),
  error: z.string().max(2000).optional(),
  /** Why the Patrol is stood down (paused by hand, or after repeated failures); absent while it's on its schedule. */
  paused: z.string().max(2000).optional(),
  nextRunAt: z.number().int().optional(),
  /** Failed runs in a row. */
  failures: z.number().int().nonnegative().optional(),
});
export type Patrol = z.infer<typeof Patrol>;

/** How a run ended: how its session or script ended, never whether the work succeeded. `running` is a run still out. */
export const PatrolRunOutcome = z.enum([
  'running',
  'finished',
  'failed',
  'needs-you',
  'timed-out',
  'skipped',
  'missed',
]);
export type PatrolRunOutcome = z.infer<typeof PatrolRunOutcome>;

/** What started a run today; as with outcomes, a run takes any short word. */
export const PatrolRunTrigger = z.enum(['schedule', 'catch-up', 'now']);
export type PatrolRunTrigger = z.infer<typeof PatrolRunTrigger>;

/** The most of a script's stdout and of its stderr a run keeps: the end of each. */
export const MAX_PATROL_OUTPUT = 8000;

const runWord = z.string().regex(/^[a-z][a-z-]{0,31}$/);

/**
 * One time a Patrol set out, or was due and didn't. A Kingdom reports a run when it starts and again when it ends, with
 * the same id, so the hub keeps the latest.
 */
export const PatrolRun = z.object({
  id: z.uuid(),
  /** The time the schedule gave, for a run it started; a Run now has none. */
  scheduledAt: z.number().int().optional(),
  startedAt: z.number().int(),
  finishedAt: z.number().int().optional(),
  /** One of `PatrolRunTrigger`'s, or a newer one. */
  trigger: runWord,
  /** One of `PatrolRunOutcome`'s, or a newer one. */
  outcome: runWord,
  /** Why it failed, was skipped or was missed, in plain words. */
  reason: z.string().max(2000).optional(),
  /** A Quest Patrol's Quest. */
  session: z.uuid().optional(),
  /** A script Patrol's exit code, and the end of what it wrote. */
  exitCode: z.number().int().optional(),
  stdout: z.string().max(MAX_PATROL_OUTPUT).optional(),
  stderr: z.string().max(MAX_PATROL_OUTPUT).optional(),
});
export type PatrolRun = z.infer<typeof PatrolRun>;

/** A Patrol as the hub lists it, with its latest run. */
export const ListedPatrol = Patrol.extend({ lastRun: PatrolRun.optional() });
export type ListedPatrol = z.infer<typeof ListedPatrol>;

/** The run a Quest was started for, carried in its `session.started` as `patrol`, so the Quest links back to it. */
export const PatrolLink = z.object({ patrol: PatrolId, run: z.uuid() });
export type PatrolLink = z.infer<typeof PatrolLink>;

/**
 * Client -> hub (REST), passed to the Kingdom: save a Patrol (with the text of the prompt file its manifest names, to
 * write beside it), delete it, or stand it down and back. The Kingdom checks a save as it would a file.
 */
export const PatrolChangeRequest = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('save'),
      manifest: PatrolManifest,
      prompt: z.string().min(1).max(MAX_PATROL_PROMPT).optional(),
    })
    .refine((save) => save.prompt === undefined || save.manifest.quest?.prompt !== undefined, {
      message: 'prompt text goes with a manifest that names a prompt file',
    })
    // A script runs with no approval, so the app may only save Quest Patrols (docs/PATROLS.md, Edit from the app).
    .refine((save) => save.manifest.script === undefined, {
      message: 'the app saves Quest Patrols only; a script Patrol is written on its Kingdom',
    }),
  z.object({ op: z.literal('delete') }),
  z.object({ op: z.literal('pause') }),
  z.object({ op: z.literal('resume') }),
]);
export type PatrolChangeRequest = z.infer<typeof PatrolChangeRequest>;

// node -> hub

/**
 * Each Patrol read on its own, so one a newer Kingdom describes in ways this hub doesn't know is kept with an error that
 * says so, and the rest still show. An entry without a usable id is left out.
 */
function readPatrols(entries: unknown[]): Patrol[] {
  return entries.flatMap((entry) => {
    const patrol = Patrol.safeParse(entry);
    if (patrol.success) return [patrol.data];
    const id = PatrolId.safeParse((entry as { id?: unknown } | null)?.id);
    if (!id.success) return [];
    const where = patrol.error.issues[0]?.path.join('.') || 'it';
    return [{ id: id.data, error: `this Patrol needs a newer hub: ${where} uses something this one doesn't know` }];
  });
}

/** Node -> hub: the Kingdom's Patrols, replacing the previous list. Resent after each connect. */
export const NodePatrols = z.object({
  kind: z.literal('patrols'),
  patrols: z
    .array(z.unknown())
    .max(100)
    .transform(readPatrols)
    .refine((patrols) => new Set(patrols.map((patrol) => patrol.id)).size === patrols.length, {
      message: 'two Patrols share an id',
    }),
});
export type NodePatrols = z.infer<typeof NodePatrols>;

/** Node -> hub: a run started or ended. The Kingdom holds its latest few in memory and sends them again on reconnect. */
export const NodePatrolRun = z.object({ kind: z.literal('patrol-run'), patrol: PatrolId, run: PatrolRun });
export type NodePatrolRun = z.infer<typeof NodePatrolRun>;

/** Node -> hub: a `patrol-change` answered. */
export const NodePatrolChanged = z.object({
  kind: z.literal('patrol-changed'),
  requestId: z.uuid(),
  ok: z.boolean(),
  reason: z.string().max(2000).optional(),
});
export type NodePatrolChanged = z.infer<typeof NodePatrolChanged>;

// hub -> node: frames of their own, not `NodeCommand`s, so a client can only reach them through the hub's routes.

/** Hub -> node: run a Patrol now. */
export const HubPatrolRunNow = z.object({ kind: z.literal('patrol-run-now'), patrol: PatrolId });
export type HubPatrolRunNow = z.infer<typeof HubPatrolRunNow>;

/** Hub -> node: change a Patrol as the user asked. Answered by `patrol-changed`. */
export const HubPatrolChange = z.object({
  kind: z.literal('patrol-change'),
  requestId: z.uuid(),
  patrol: PatrolId,
  change: PatrolChangeRequest,
});
export type HubPatrolChange = z.infer<typeof HubPatrolChange>;

// hub -> client frames, listed in `HubToClient`

/** A Kingdom's Patrols changed. `editable` says whether it takes Patrols from the app right now. */
export const PatrolsFrame = z.object({
  kind: z.literal('patrols'),
  node: z.string(),
  editable: z.boolean(),
  patrols: z.array(ListedPatrol),
});
/** A Patrol's run started or ended: its recent runs as they now stand. */
export const PatrolRunsFrame = z.object({
  kind: z.literal('patrol-runs'),
  node: z.string(),
  patrol: PatrolId,
  runs: z.array(PatrolRun),
});
