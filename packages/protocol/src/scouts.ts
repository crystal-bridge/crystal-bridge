import { z } from 'zod';
import { PermissionMode } from './mode.js';

/**
 * Scouts and Boards (docs/SCOUTS.md): a Scout is a job on a Kingdom that runs a collector script on a schedule, and its
 * Board is the tab showing what it found. Nothing here is engine-specific.
 */

/** A Scout's folder name under `~/.crystal-bridge/scouts/`, which is also its id. Safe as a path segment and a URL part. */
export const ScoutId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export type ScoutId = z.infer<typeof ScoutId>;

/** An action's key in `scout.json`, which items name in their `actions`. */
export const ActionKey = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
export type ActionKey = z.infer<typeof ActionKey>;

/** Five-field cron, with the time zone it means, so a Scout means the same thing on every machine. */
export const ScoutSchedule = z.object({
  cron: z
    .string()
    .max(200)
    .regex(/^\s*\S+(\s+\S+){4}\s*$/),
  timezone: z.string().min(1).max(64),
});
export type ScoutSchedule = z.infer<typeof ScoutSchedule>;

const label = z.string().min(1).max(40);
/** A file in the Scout's folder, such as a prompt template. */
const scoutFile = z.string().min(1).max(255);
/** A text with `{{...}}` placeholders the Kingdom fills from an item. */
const template = z.string().min(1).max(4096);

/** What a button on a Board does. The Kingdom carries out `quest` and `run`; the hub handles the rest. */
export const ScoutAction = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('quest'),
    label,
    project: template,
    prompt: scoutFile,
    mode: PermissionMode.optional(),
    worktree: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('run'),
    label,
    command: z.array(z.string().max(4096)).min(1).max(64),
    /** Ask before running. */
    confirm: z.boolean().optional(),
    /** Several items may go in one run. */
    batch: z.boolean().optional(),
    /** What a run that succeeds does to its items; unset leaves them as they were. */
    then: z.enum(['done', 'dismiss']).optional(),
  }),
  z.object({ kind: z.literal('link'), label, url: template }),
  /** Hides an item for a while: a count of minutes, hours, days or weeks, such as `1d`. */
  z.object({
    kind: z.literal('snooze'),
    label,
    for: z.string().regex(/^[1-9]\d{0,3}[mhdw]$/),
  }),
  z.object({ kind: z.literal('done'), label }),
  z.object({ kind: z.literal('dismiss'), label }),
]);
export type ScoutAction = z.infer<typeof ScoutAction>;

export const ScoutView = z.enum(['list', 'checklist', 'table']);
export type ScoutView = z.infer<typeof ScoutView>;

/** `scout.json`. Fields a newer Kingdom adds are dropped, not refused, so an older hub still shows the Scout. */
export const ScoutManifest = z.object({
  name: z.string().min(1).max(80),
  schedule: ScoutSchedule,
  collect: z.object({
    command: z.array(z.string().max(4096)).min(1).max(64),
    timeoutSeconds: z.number().int().min(1).max(3600).optional(),
  }),
  synthesize: z.object({ prompt: scoutFile, when: z.enum(['changed']).optional() }).optional(),
  view: ScoutView,
  actions: z.record(ActionKey, ScoutAction).refine((actions) => Object.keys(actions).length <= 32, {
    message: 'at most 32 actions',
  }),
  /** The actions an item gets when it names none. */
  defaults: z.array(ActionKey).max(16).optional(),
});
export type ScoutManifest = z.infer<typeof ScoutManifest>;

/** A Scout as its Kingdom reports it: the last good `scout.json`, and why the current one doesn't load, if it doesn't. */
export const Scout = z.object({
  id: ScoutId,
  /** Absent for a Scout whose `scout.json` has never loaded. */
  manifest: ScoutManifest.optional(),
  error: z.string().max(2000).optional(),
  /** Why the Scout stopped running on its schedule, such as repeated failures; absent when it runs. */
  paused: z.string().max(2000).optional(),
  nextRunAt: z.number().int().optional(),
});
export type Scout = z.infer<typeof Scout>;

export const MAX_SCOUT_ITEMS = 1000;
export const MAX_SCOUT_STDERR = 8000;

const fieldValue = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);

/** One thing a Scout found. `id` stays the same across runs; `rev` changes when it changes in a way worth seeing again. */
export const ScoutItem = z.object({
  id: z.string().min(1).max(500),
  rev: z.string().max(200).optional(),
  title: z.string().min(1).max(500),
  subtitle: z.string().max(500).optional(),
  /** Only web links, so a Board never opens a `javascript:` URL. */
  url: z
    .url({ protocol: /^https?$/ })
    .max(4096)
    .optional(),
  group: z.string().max(80).optional(),
  fields: z
    .record(z.string().max(64), fieldValue)
    .refine((fields) => Object.keys(fields).length <= 32, { message: 'at most 32 fields' })
    .optional(),
  actions: z.array(ActionKey).max(16).optional(),
});
export type ScoutItem = z.infer<typeof ScoutItem>;

const itemList = z
  .array(ScoutItem)
  .max(MAX_SCOUT_ITEMS)
  .refine((items) => new Set(items.map((item) => item.id)).size === items.length, {
    message: 'two items share an id',
  });

/** What a collector prints on stdout. */
export const ScoutItems = z.object({ items: itemList });
export type ScoutItems = z.infer<typeof ScoutItems>;

export const ScoutRunOutcome = z.enum(['succeeded', 'failed', 'timed-out', 'skipped']);
export type ScoutRunOutcome = z.infer<typeof ScoutRunOutcome>;

/** One execution of a Scout, or one it skipped because the last was still going. */
export const ScoutRun = z.object({
  id: z.uuid(),
  startedAt: z.number().int(),
  finishedAt: z.number().int().optional(),
  trigger: z.enum(['schedule', 'catch-up', 'now']),
  outcome: ScoutRunOutcome,
  /** Why it failed or was skipped, in plain words. */
  reason: z.string().max(2000).optional(),
  /** The end of what the collector wrote to stderr. */
  stderr: z.string().max(MAX_SCOUT_STDERR).optional(),
  /** How many items it found. */
  items: z.number().int().nonnegative().optional(),
  /** What the synthesis step cost, in US dollars as the CLI reports it. */
  costUsd: z.number().nonnegative().optional(),
});
export type ScoutRun = z.infer<typeof ScoutRun>;

/** Where an item stands for the user. Whether it's still in the collector's list is `goneAt`, apart from this. */
export const BoardItemState = z.enum(['new', 'seen', 'snoozed', 'done', 'dismissed']);
export type BoardItemState = z.infer<typeof BoardItemState>;

/** An item as a Board shows it. A snooze that has run out reads as `new`. */
export const BoardItem = ScoutItem.extend({
  state: BoardItemState,
  /** For a snoozed item: when it comes back. */
  until: z.number().int().optional(),
  firstSeen: z.number().int(),
  /** When it appeared or its `rev` last changed. */
  changedAt: z.number().int(),
  /** When it left the collector's list; absent while it's there. */
  goneAt: z.number().int().optional(),
});
export type BoardItem = z.infer<typeof BoardItem>;

/** A Board: its Scout's latest runs, newest first, and its items, those gone lately included. */
export const Board = z.object({ scout: ScoutId, runs: z.array(ScoutRun), items: z.array(BoardItem) });
export type Board = z.infer<typeof Board>;

/** A Scout as the hub lists it: how many items are new, and its latest run. */
export const ListedScout = Scout.extend({ fresh: z.number().int().nonnegative(), lastRun: ScoutRun.optional() });
export type ListedScout = z.infer<typeof ListedScout>;

/** Client -> hub (REST): change several items of one Board at once. A snooze says until when. */
export const BoardItemsChange = z
  .object({
    ids: z.array(z.string().min(1).max(500)).min(1).max(MAX_SCOUT_ITEMS),
    state: BoardItemState,
    until: z.number().int().optional(),
  })
  .refine((change) => (change.state === 'snoozed') === (change.until !== undefined), {
    message: 'a snooze needs `until`, and only a snooze takes one',
  });
export type BoardItemsChange = z.infer<typeof BoardItemsChange>;

// node -> hub

/** Node -> hub: the Kingdom's Scouts, replacing the previous list. Resent after each connect. */
export const NodeScouts = z.object({ kind: z.literal('scouts'), scouts: z.array(Scout).max(100) });
export type NodeScouts = z.infer<typeof NodeScouts>;

/** Node -> hub: a run ended. A run that succeeded carries the collector's whole list; the hub compares it with the last. */
export const NodeScoutRun = z
  .object({ kind: z.literal('scout-run'), scout: ScoutId, run: ScoutRun, items: itemList.optional() })
  .refine((frame) => (frame.run.outcome === 'succeeded') === (frame.items !== undefined), {
    message: 'a run that succeeded carries its items, and only that one',
  });
export type NodeScoutRun = z.infer<typeof NodeScoutRun>;

/** Node -> hub: a `scout-action` answered. `session` is the Quest a `quest` action started. */
export const NodeScoutActed = z.object({
  kind: z.literal('scout-acted'),
  requestId: z.uuid(),
  ok: z.boolean(),
  reason: z.string().max(2000).optional(),
  session: z.uuid().optional(),
});
export type NodeScoutActed = z.infer<typeof NodeScoutActed>;

// hub -> node: frames of their own, not `NodeCommand`s, so a client can only reach them through the hub's routes.

/** Hub -> node: run a Scout now. */
export const HubScoutRunNow = z.object({ kind: z.literal('scout-run-now'), scout: ScoutId });
export type HubScoutRunNow = z.infer<typeof HubScoutRunNow>;

/** Hub -> node: carry out a `quest` or `run` action on these items, as the hub stores them. */
export const HubScoutAction = z.object({
  kind: z.literal('scout-action'),
  requestId: z.uuid(),
  scout: ScoutId,
  action: ActionKey,
  items: z.array(ScoutItem).min(1).max(MAX_SCOUT_ITEMS),
});
export type HubScoutAction = z.infer<typeof HubScoutAction>;

// hub -> client frames, listed in `HubToClient`

/** A Kingdom's Scouts changed. */
export const ScoutsFrame = z.object({ kind: z.literal('scouts'), node: z.string(), scouts: z.array(ListedScout) });
/** A run ended: the Board as it now stands. */
export const BoardFrame = z.object({ kind: z.literal('board'), node: z.string(), board: Board });
/** Someone changed items' state, on this device or another. */
export const BoardItemsFrame = z.object({
  kind: z.literal('board-items'),
  node: z.string(),
  scout: ScoutId,
  items: z.array(BoardItem),
});
