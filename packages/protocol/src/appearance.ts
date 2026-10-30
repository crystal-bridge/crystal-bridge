import { z } from 'zod';

/**
 * How a user's Kingdoms look, shared across all their devices (unlike names, hidden Kingdoms and notification
 * levels, which stay per device): each Kingdom's icon, banner colour and party leader, how tabs show the colour, and the colour of their own prompts. Ids are the
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

export const Appearance = z.object({
  looks: z.record(z.string().max(200), KingdomLookChoice).optional(),
  tabStyle: z.string().max(32).optional(),
  /** The colour of the user's own prompts in the chat. */
  promptColour: z.string().max(32).optional(),
});
export type Appearance = z.infer<typeof Appearance>;
