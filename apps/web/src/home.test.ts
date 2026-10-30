import { describe, expect, it } from 'vitest';
import { activityLine, recentProjects, startOfDay, startOfWeek, sumStats, type TurnStats } from './home.js';
import type { SessionSummary } from './components/SessionList.js';

const session = (over: Partial<SessionSummary>): SessionSummary => ({
  id: Math.random().toString(36),
  node: 'n1',
  cwd: '/w/app',
  label: 'x',
  status: 'idle',
  createdAt: 1,
  ...over,
});

describe('home page data', () => {
  it('finds local midnight and the Monday that starts the week', () => {
    const wed = new Date(2026, 9, 28, 15, 30).getTime(); // a Wednesday afternoon
    expect(new Date(startOfDay(wed)).toString()).toBe(new Date(2026, 9, 28).toString());
    expect(new Date(startOfWeek(wed)).toString()).toBe(new Date(2026, 9, 26).toString());
    const sun = new Date(2026, 10, 1, 9).getTime();
    expect(new Date(startOfWeek(sun)).toString()).toBe(new Date(2026, 9, 26).toString());
  });

  it('sums turn stats across the Kingdoms asked for', () => {
    const row = (node: string, turns: number, costUsd: number): TurnStats => ({
      node,
      turns,
      kos: 1,
      costUsd,
      durationMs: 1000,
      tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    });
    expect(sumStats([row('a', 2, 0.5), row('b', 3, 1), row('hidden', 9, 9)], new Set(['a', 'b']))).toEqual({
      node: '',
      turns: 5,
      kos: 2,
      costUsd: 1.5,
      durationMs: 2000,
      tokens: { input: 2, output: 4, cacheRead: 6, cacheWrite: 8 },
    });
  });

  it('ranks a Kingdom-s project folders by how many Quests used them, then by recency', () => {
    const sessions = [
      session({ cwd: '/w/app', createdAt: 1 }),
      session({ cwd: '/w/app', createdAt: 2 }),
      session({ cwd: '/w/docs', createdAt: 9, lastActivity: 50 }),
      session({ cwd: '/w/old', createdAt: 3 }),
    ];
    expect(recentProjects(sessions, 2)).toEqual([
      { cwd: '/w/app', name: 'app', count: 2, last: 2 },
      { cwd: '/w/docs', name: 'docs', count: 1, last: 50 },
    ]);
  });

  it('words activity, naming no Quest for a Discreet Kingdom', () => {
    const turn = { session: 's', node: 'n1', label: 'Fix login', ts: 1, kind: 'turn' as const, outcome: 'success' };
    // The label is a truncated prompt: quotes mark where it ends and the event begins.
    expect(activityLine(turn, 'Home', false)).toBe('Home: “Fix login” finished a turn');
    expect(activityLine({ ...turn, outcome: 'error' }, 'Home', false)).toBe('Home: “Fix login” was KO’d');
    expect(activityLine({ ...turn, kind: 'started' }, 'Home', false)).toBe('Home: “Fix login” set out');
    expect(activityLine({ ...turn, label: 'Reply with a heading, a ' }, 'Home', false)).toBe(
      'Home: “Reply with a heading, a…” finished a turn',
    );
    expect(activityLine({ ...turn, kind: 'closed' }, 'Home', true)).toBe('Home: a Quest was completed');
    expect(activityLine(turn, 'Home', true)).toBe('Home: a Quest finished a turn');
  });
});
