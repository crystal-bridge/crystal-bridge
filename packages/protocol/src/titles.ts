import { z } from 'zod';

/** The longest Quest title, in characters: a tab shows a few words, and a title is never data. */
export const MAX_QUEST_TITLE = 80;

/**
 * A Quest's title: one line, trimmed, with something visible. It shows in tabs and notifications, so it refuses control
 * and format characters (bidi overrides, zero-width marks) and line or paragraph separators, which could hide or
 * reorder what a person reads.
 */
export const QuestTitle = z
  .string()
  .trim()
  .min(1)
  .max(MAX_QUEST_TITLE)
  .regex(/^[^\p{Cc}\p{Cf}\u2028\u2029]*$/u, 'one line, with no control or format characters')
  .regex(/[^\p{White_Space}\p{Z}]/u, 'something visible');
export type QuestTitle = z.infer<typeof QuestTitle>;

/**
 * Who named a Quest. `quest` is the Quest itself, through Crystal's `title` tool; `you` is a person, from the app. A
 * title you gave is kept: the Quest's own titles after it change nothing.
 */
export const TitledBy = z.enum(['quest', 'you']);
export type TitledBy = z.infer<typeof TitledBy>;

/**
 * The `session.titled` payload. `title` is the plain title every theme can show; `themed` is the same in the theme's
 * voice, when the Quest gave one.
 */
export const SessionTitled = z.object({
  title: QuestTitle,
  themed: QuestTitle.optional(),
  by: TitledBy,
});
export type SessionTitled = z.infer<typeof SessionTitled>;

/**
 * The voice a Quest names itself in. It's the one themed string outside the web app's `theme/words.ts`, because the
 * Kingdom tells the model and the theme lives in the app: a fork with another theme swaps it here (docs/THEME.md).
 */
export const TITLE_VOICE = 'a retro fantasy RPG';

/** What the Quest passes Crystal's `title` tool. */
export const TitleToolInput = z.object({
  themed: QuestTitle.describe(
    `the title in the voice of ${TITLE_VOICE} quest, e.g. "The Siege of the Flaky Smoke Test"`,
  ),
  plain: QuestTitle.describe('the same in plain words, e.g. "Fix the flaky smoke test"'),
});
export type TitleToolInput = z.infer<typeof TitleToolInput>;

/** The `title` tool's description: when to call it, so a Quest names itself once and not every turn. */
export const TITLE_TOOL_DESCRIPTION =
  "Name this session for the user's tab strip. Call it once, as soon as you understand what the user is asking for, " +
  'and again only if the work changes course. Give a short title (a few words) in two forms: `themed`, in the voice ' +
  `of ${TITLE_VOICE} quest, and \`plain\`, saying the same in plain words. Both must say what the work actually ` +
  'is. It needs no approval. If the user has named the session themselves, their name stays.';
