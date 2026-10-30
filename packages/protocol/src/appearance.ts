import { z } from 'zod';

/**
 * How a user's Kingdoms look, shared across all their devices (unlike names, hidden Kingdoms and notification
 * levels, which stay per device): each Kingdom's icon, banner colour, party leader and Belt, how tabs show the colour, and the colour of their own prompts. Ids are the
 * client's own lists (theme data), so the hub stores them without knowing what they mean.
 */
export const KingdomLookChoice = z.object({
  icon: z.string().max(64).optional(),
  colour: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  /** The Class that leads this Kingdom's Quests, or `varied` for a different one per Quest. */
  leader: z.string().max(64).optional(),
});
export type KingdomLookChoice = z.infer<typeof KingdomLookChoice>;

/**
 * One quick action on a Kingdom's Belt: the prompt text it stands for and how it shows. `source` names the Inventory
 * entry it came from; a slot without one is text the user typed.
 */
export const BeltSlot = z.object({
  label: z.string().max(200),
  text: z.string().max(4000),
  icon: z.string().max(64).optional(),
  /** Sends at once instead of filling the prompt. */
  now: z.boolean().optional(),
  source: z.object({ category: z.string().max(64), name: z.string().max(200) }).optional(),
});
export type BeltSlot = z.infer<typeof BeltSlot>;

export const Appearance = z.object({
  looks: z.record(z.string().max(200), KingdomLookChoice).optional(),
  /** Each Kingdom's Belt; a null is an empty slot. */
  belts: z.record(z.string().max(200), z.array(BeltSlot.nullable()).max(8)).optional(),
  tabStyle: z.string().max(32).optional(),
  /** The colour of the user's own prompts in the chat. */
  promptColour: z.string().max(32).optional(),
});
export type Appearance = z.infer<typeof Appearance>;
