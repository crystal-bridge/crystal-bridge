import { z } from 'zod';
import { QuestTitle } from './envelope.js';
import { PatrolId } from './patrols.js';

/** The longest Errand body, from a Quest or by hand: Markdown, commands in fenced blocks. */
export const MAX_ERRAND_BODY = 8000;
/** How many Errands a Quest may leave in one turn; Crystal refuses the rest, with the reason. */
export const MAX_ERRANDS_PER_TURN = 10;

export const ErrandBody = z.string().max(MAX_ERRAND_BODY);
/** A project folder, as New Quest and Patrols name one: one line, no control or format characters. */
export const ErrandProject = z
  .string()
  .min(1)
  .max(4096)
  .refine((text) => !/[\p{Cc}\p{Cf}]/u.test(text), { error: 'a project is one folder path' });
/** Node -> hub, `errand.left`: an Errand a Quest left with Crystal's `errand` tool. Crystal picks the id. */
export const ErrandLeftPayload = z.object({ id: z.uuid(), title: QuestTitle, body: ErrandBody });
export type ErrandLeftPayload = z.infer<typeof ErrandLeftPayload>;
export const ErrandState = z.enum(['open', 'done', 'dismissed']);
export type ErrandState = z.infer<typeof ErrandState>;
/** An Errand as the hub lists it. `patrol` is the Patrol whose Quest left it, read from that Quest's start. */
export const Errand = z.object({
  id: z.uuid(),
  session: z.uuid().optional(),
  seq: z.number().int().nonnegative().optional(),
  project: z.string().optional(),
  title: z.string(),
  body: z.string(),
  state: ErrandState,
  by: z.enum(['quest', 'you']),
  created: z.number().int(),
  updated: z.number().int(),
  /** When it was last ticked done or dismissed; the hub deletes it 30 days later. */
  closed: z.number().int().optional(),
  patrol: PatrolId.optional(),
});
export type Errand = z.infer<typeof Errand>;
/** Hub -> every client: a Kingdom's Errands changed; the whole list as it now stands. Older clients ignore it. */
export const ErrandsFrame = z.object({ kind: z.literal('errands'), node: z.string(), errands: z.array(Errand) });
export type ErrandsFrame = z.infer<typeof ErrandsFrame>;
/** Client -> hub (REST): bodies for Add Errand, an edit, and a tick, dismiss or reopen. */
export const ErrandCreate = z.object({
  title: QuestTitle,
  body: ErrandBody.default(''),
  project: ErrandProject.optional(),
});
export type ErrandCreate = z.infer<typeof ErrandCreate>;
export const ErrandEdit = z.object({ title: QuestTitle, body: ErrandBody });
export type ErrandEdit = z.infer<typeof ErrandEdit>;
export const ErrandStateChange = z.object({ state: ErrandState });
export type ErrandStateChange = z.infer<typeof ErrandStateChange>;
