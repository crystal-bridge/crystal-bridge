import { createContext } from 'react';

/**
 * Pointless levels (#23): each Hero Class earns XP from the Quests it leads, across all Kingdoms, for life. Arbitrary on
 * purpose, a rough fun measure of use. The hub counts each Quest's battles (`/api/xp`, engine-neutral); the rules and
 * the curve are data here, so a fork can change them.
 */

/** One Quest's lifetime battles, as the hub reports them. */
export interface QuestXp {
  session: string;
  node: string;
  won: number;
  kos: number;
  completed: boolean;
}

/** XP per battle won, per KO (you learn from defeat), and for completing (closing) a Quest. */
export const XP_RULES = { won: 10, ko: 2, completed: 50 } as const;

export function questXpPoints(quest: QuestXp): number {
  return quest.won * XP_RULES.won + quest.kos * XP_RULES.ko + (quest.completed ? XP_RULES.completed : 0);
}

/** The XP it takes to reach level L: 50 × L × (L−1), so 100 for Lv 2, 300 for Lv 3, 4,500 for Lv 10. */
export function xpToReach(level: number): number {
  return 50 * level * (level - 1);
}

export interface Level {
  level: number;
  xp: number;
  /** XP gained since reaching this level, and the XP between it and the next. */
  into: number;
  span: number;
}

export function levelFor(xp: number): Level {
  let level = 1;
  while (xpToReach(level + 1) <= xp) level++;
  return { level, xp, into: xp - xpToReach(level), span: xpToReach(level + 1) - xpToReach(level) };
}

/** Each Class's XP: every Quest's XP, credited to the Class that leads it. */
export function classXp(
  quests: readonly QuestXp[],
  leaderOf: (session: string) => string | undefined,
): Record<string, number> {
  const xp: Record<string, number> = {};
  for (const quest of quests) {
    const leader = leaderOf(quest.session);
    if (leader) xp[leader] = (xp[leader] ?? 0) + questXpPoints(quest);
  }
  return xp;
}

/** Each Class's level, for the Party card and the Roster; empty when levels aren't shown. */
export const LevelContext = createContext<Record<string, Level>>({});
