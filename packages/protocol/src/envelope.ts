import { z } from 'zod';

// node -> hub -> client
export const EventType = z.enum([
  'session.started', // payload: { cwd, prompt, label, worktree?, adopted?, forkedFrom?, engine?, effort? }
  'claude.event', // payload: { engine: 'claude', raw: unknown }  one stream-json line, untouched
  'user.message', // payload: { text }  a follow-up from session.send; the CLI doesn't echo stdin
  'permission.request', // payload: { requestId, toolName, input, toolUseId? }
  'permission.resolved', // payload: { requestId, behavior: 'allow' | 'deny' }
  'session.ended', // payload: { exitCode: number | null, signal: string | null, reason: 'idle' | 'exit' | 'error' }
  'session.resumed', // payload: {}  a send respawned the process with --resume
  'session.closed', // payload: { worktree?: { removed, reason? } }  closed on purpose; no more follow-ups
  'turn.finished', // payload: { outcome, summary?, costUsd?, durationMs?, tokens? }  a turn ended, engine-neutral
  'usage', // payload: UsagePayload  the node account's plan limits, as last reported by its engine
  'error', // payload: { message }
]);
export type EventType = z.infer<typeof EventType>;

export const Envelope = z.object({
  node: z.string().min(1),
  session: z.uuid(),
  seq: z.number().int().nonnegative(),
  ts: z.number().int(),
  type: EventType,
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
  usedPct: z.number(), // 0-100
  resetsAt: z.number().int().nullable(), // epoch ms
  status: z.string(), // the engine's own status, e.g. allowed
});
export type UsageWindow = z.infer<typeof UsageWindow>;

export const UsagePayload = z.object({ windows: z.array(UsageWindow) });
export type UsagePayload = z.infer<typeof UsagePayload>;
