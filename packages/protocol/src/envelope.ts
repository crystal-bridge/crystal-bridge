import { z } from 'zod';

/**
 * The event types this release knows, for code that means one of them. An envelope's own `type` is open: see
 * `Envelope`.
 */
export const EventType = z.enum([
  'session.started', // payload: { cwd, prompt, label, mode?, worktree?, adopted?, forkedFrom?, engine?, effort?, scout?, patrol? }  scout: ScoutLink, patrol: PatrolLink
  'claude.event', // payload: { engine: 'claude', raw: unknown }  one stream-json line, untouched
  'user.message', // payload: { text }  a follow-up from session.send; the CLI doesn't echo stdin
  'permission.request', // payload: { requestId, toolName, input, toolUseId? }
  'permission.resolved', // payload: { requestId, behavior: 'allow' | 'deny' }
  // reason 'restart' comes from the hub: the node restarted mid-turn, and `resuming` says whether the Quest is being brought back
  'session.ended', // payload: { exitCode: number | null, signal: string | null, reason: 'idle' | 'exit' | 'error' | 'restart', resuming? }
  'session.resumed', // payload: {}  a send respawned the process with --resume
  'session.closed', // payload: { worktree?: { removed, reason? } }  closed on purpose; no more follow-ups
  'turn.finished', // payload: { outcome, summary?, costUsd?, durationMs?, tokens? }  a turn ended, engine-neutral
  'usage', // payload: UsagePayload  the node account's plan limits, as last reported by its engine
  'session.effort', // payload: { effort? }  the Quest's effort from now on; none is the CLI's default
  'session.mode', // payload: { mode }  the Quest's permission mode from now on
  'quest.titled', // payload: QuestTitledPayload  the Quest named itself (Crystal's `title` tool); only the first counts; a name set by hand wins
  'errand.left', // payload: ErrandLeftPayload  a step a Quest left the user (Crystal's `errand` tool); the hub also keeps it in `errands`
  'turn.tally', // payload: TurnTallyPayload  what a turn changed (files, pull requests), after Crystal's diff; the hub adds it to the turn's record
  'deed.recorded', // payload: DeedRecordedPayload  a Deed from the `deed` tool or the call at Close; the hub also keeps it in `deeds`
  'deeds.closing', // payload: DeedsClosingPayload  how the call at Close went
  'terminal.screen', // payload: { open, text?, raised?, held? }  an interactive Quest's screen, while it needs a person
  'error', // payload: { message }
]);
export type EventType = z.infer<typeof EventType>;

/** The longest Quest title, from the Quest or by hand: a tab's worth, not a summary. */
export const MAX_QUEST_TITLE = 120;

/**
 * A Quest's name, from the Quest or by hand: trimmed, and without control or format characters (a line break, a
 * right-to-left override), which could disguise it in a tab or a notification.
 */
export const QuestTitle = z
  .string()
  .trim()
  .min(1)
  .max(MAX_QUEST_TITLE)
  .refine((text) => !/[\p{Cc}\p{Cf}]/u.test(text), { error: 'a name is one line of plain text' });

/** A Quest's own name for itself: `title` in the theme's voice, `plain` the same in plain words for the Classic theme. */
export const QuestTitledPayload = z.object({ title: QuestTitle, plain: QuestTitle });
export type QuestTitledPayload = z.infer<typeof QuestTitledPayload>;

/** The longest `type` on the wire. The store keeps and indexes it, so it's a short name and never data. */
export const MAX_EVENT_TYPE = 64;

/**
 * node -> hub -> client. `type` is open so a new event type is additive: a hub stores and acks one it doesn't know
 * instead of leaving the node to resend it forever, and a client ignores it. The hub reads only the types it knows, so
 * an unknown one is an opaque row, and whatever it carries stays in `payload`.
 */
export const Envelope = z.object({
  node: z.string().min(1),
  session: z.uuid(),
  seq: z.number().int().nonnegative(),
  ts: z.number().int(),
  type: z.string().min(1).max(MAX_EVENT_TYPE),
  payload: z.unknown(),
});
export type Envelope = z.infer<typeof Envelope>;

/**
 * Plan usage for the account a node's engine runs under. The node translates its engine's own
 * report into this shape, so the hub and clients never parse engine-specific limits.
 */
export const UsageWindow = z.object({
  id: z.string(), // the engine's window name, e.g. five_hour
  label: z.string(), // short display name, e.g. 5h
  spanHours: z.number().positive().optional(), // the window's length, so limits can be ordered without knowing names
  usedPct: z.number(), // 0-100
  resetsAt: z.number().int().nullable(), // epoch ms
  status: z.string(), // the engine's own status, e.g. allowed
});
export type UsageWindow = z.infer<typeof UsageWindow>;

export const UsagePayload = z.object({ windows: z.array(UsageWindow) });
export type UsagePayload = z.infer<typeof UsagePayload>;
