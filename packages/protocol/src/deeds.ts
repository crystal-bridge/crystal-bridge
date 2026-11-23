import { z } from 'zod';
import { QuestTitle } from './envelope.js';
import { PatrolId } from './patrols.js';

/** The longest detail under a Deed: plain text, no Markdown, so no links. */
export const MAX_DEED_DETAIL = 280;
/** How many Deeds a Quest may record in one turn with the `deed` tool; Crystal refuses the rest, with the reason. */
export const MAX_DEEDS_PER_TURN = 3;
/** How many Deeds the call at Close may write. */
export const MAX_CLOSING_DEEDS = 5;
/** How many pull request links a turn's tally carries. */
export const MAX_TALLY_PRS = 10;
/** The longest pull request link a `turn.tally` takes. */
export const MAX_TALLY_LINK = 500;

/** A Deed's detail: one paragraph of plain text, without control or format characters. */
export const DeedDetail = z
  .string()
  .trim()
  .max(MAX_DEED_DETAIL)
  .refine((text) => !/[\p{Cc}\p{Cf}]/u.test(text), { error: 'a detail is one paragraph of plain text' });
export type DeedDetail = z.infer<typeof DeedDetail>;

/** Node -> hub, `turn.tally`: what a turn changed, sent once Crystal's diff is in. `seq` is its `turn.finished`'s. */
export const TurnTallyPayload = z.object({
  seq: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  prs: z
    .array(
      z
        .string()
        .max(MAX_TALLY_LINK)
        .regex(/^https?:\/\//),
    )
    .max(MAX_TALLY_PRS),
});
export type TurnTallyPayload = z.infer<typeof TurnTallyPayload>;

/** Node -> hub, `deed.recorded`: a Deed from the `deed` tool, or from the call at Close (`closing`). Crystal picks the id. */
export const DeedRecordedPayload = z.object({
  id: z.uuid(),
  deed: QuestTitle,
  detail: DeedDetail.optional(),
  closing: z.literal(true).optional(),
});
export type DeedRecordedPayload = z.infer<typeof DeedRecordedPayload>;

// 'writing' is sent first, when the call starts, so every device can show it under way.
export const DeedsClosingOutcome = z.enum([
  'writing',
  'recorded',
  'empty',
  'timeout',
  'budget',
  'failed',
  'unreadable',
]);
export type DeedsClosingOutcome = z.infer<typeof DeedsClosingOutcome>;

/** Node -> hub, `deeds.closing`: how the call at Close went, after its Deeds. */
export const DeedsClosingPayload = z.object({
  outcome: DeedsClosingOutcome,
  costUsd: z.number().nonnegative().optional(),
  reason: z.string().max(300).optional(),
});
export type DeedsClosingPayload = z.infer<typeof DeedsClosingPayload>;

export const DeedKind = z.enum(['turn', 'deed', 'closing', 'patrol', 'close']);
export type DeedKind = z.infer<typeof DeedKind>;

/** A row of the feed as the hub lists it (docs/DEEDS.md, Keep the scrolls). Absent keys were never reported. */
export const Deed = z.object({
  id: z.string().min(1).max(200),
  session: z.uuid().optional(),
  seq: z.number().int().nonnegative().optional(),
  patrol: PatrolId.optional(),
  project: z.string().optional(),
  kind: DeedKind,
  text: z.string().optional(),
  detail: z.string().optional(),
  outcome: z.string().optional(),
  costUsd: z.number().optional(),
  durationMs: z.number().int().optional(),
  files: z.number().int().nonnegative().optional(),
  prs: z.array(z.string()).optional(),
  at: z.number().int(),
});
export type Deed = z.infer<typeof Deed>;

/**
 * Hub -> client, `GET /api/nodes/:node/deeds`: rows with after <= at < before, newest first. A full page carries `more`,
 * its last row's time and id, to send back as `beforeAt` and `beforeId` for the rest of the same window; `older`, the
 * time of the newest row before `after`, is where the next window starts once this one has no `more`.
 */
export const DeedsPage = z.object({
  deeds: z.array(Deed),
  older: z.number().int().optional(),
  more: z.object({ at: z.number().int(), id: z.string().min(1).max(200) }).optional(),
});
export type DeedsPage = z.infer<typeof DeedsPage>;

/**
 * Hub -> every client: rows of a Kingdom's feed that were added or changed. Older clients ignore it. `cleared` (with no
 * rows) says the hub forgot the Kingdom, so a client drops every row it holds for it.
 */
export const DeedsFrame = z.object({
  kind: z.literal('deeds'),
  node: z.string(),
  deeds: z.array(Deed),
  cleared: z.literal(true).optional(),
});
export type DeedsFrame = z.infer<typeof DeedsFrame>;
