import { describe, expect, it } from 'vitest';
import { classXp, kingdomLevels, levelFor, type QuestXp, questXpPoints, xpToReach } from './levels.js';

describe('levels', () => {
  it('scores a Quest: 10 per battle won, 2 per KO, 50 for completing it', () => {
    expect(questXpPoints({ session: 'a', node: 'n', won: 3, kos: 1, completed: true })).toBe(82);
    expect(questXpPoints({ session: 'a', node: 'n', won: 0, kos: 0, completed: false })).toBe(0);
  });

  it('needs 50 × L × (L−1) XP to reach level L', () => {
    expect([1, 2, 3, 10].map(xpToReach)).toEqual([0, 100, 300, 4500]);
  });

  it('gives the level and the way to the next one', () => {
    expect(levelFor(0)).toEqual({ level: 1, xp: 0, into: 0, span: 100 });
    expect(levelFor(99).level).toBe(1);
    expect(levelFor(100)).toEqual({ level: 2, xp: 100, into: 0, span: 200 });
    expect(levelFor(450)).toEqual({ level: 3, xp: 450, into: 150, span: 300 });
  });

  it("credits each Quest's XP to the Class that led it", () => {
    const quests = [
      { session: 'a', node: 'n', won: 2, kos: 0, completed: false },
      { session: 'b', node: 'n', won: 1, kos: 0, completed: true },
      { session: 'c', node: 'n', won: 5, kos: 0, completed: false },
    ];
    const leader = (session: string) => (session === 'c' ? 'rogue' : 'paladin');
    expect(classXp(quests, leader)).toEqual({ paladin: 80, rogue: 50 });
  });
});

describe('kingdomLevels', () => {
  const quest = (session: string, node: string, won: number): QuestXp => ({
    session,
    node,
    won,
    kos: 0,
    completed: false,
  });
  const quests = [quest('a', 'here', 15), quest('b', 'here', 3), quest('c', 'there', 40), quest('d', 'here', 0)];
  const leaderOf = (session: string) => ({ a: 'paladin', b: 'mage', c: 'mage', d: 'rogue' })[session];

  it('counts only the Quests led in this Kingdom', () => {
    const levels = kingdomLevels(quests, 'here', leaderOf);
    expect(levels.paladin?.xp).toBe(150);
    expect(levels.mage?.xp).toBe(30);
  });

  it('leaves out a Hero with no XP here', () => {
    expect(Object.keys(kingdomLevels(quests, 'here', leaderOf)).sort()).toEqual(['mage', 'paladin']);
    expect(kingdomLevels(quests, 'empty', leaderOf)).toEqual({});
  });
});
