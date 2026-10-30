import { describe, expect, it } from 'vitest';
import type { SessionSummary } from './components/SessionList.js';
import { isActiveQuest, loadPutAway, projectName, putAway, questTabs, RECENT_MS, savePutAway } from './quests.js';

const NOW = 10 * RECENT_MS;

function quest(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    node: 'k',
    cwd: '/w',
    label: id,
    status: 'idle',
    createdAt: 0,
    lastActivity: NOW - 2 * RECENT_MS,
    ...overrides,
  };
}

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
    clear: () => data.clear(),
    key: () => null,
    get length() {
      return data.size;
    },
  };
}

describe('isActiveQuest', () => {
  it('counts running, waiting and recently active Quests, never closed ones', () => {
    const waiting = new Set(['w']);
    expect(isActiveQuest(quest('r', { status: 'running' }), NOW, waiting)).toBe(true);
    expect(isActiveQuest(quest('w'), NOW, waiting)).toBe(true);
    expect(isActiveQuest(quest('recent', { lastActivity: NOW - RECENT_MS + 1 }), NOW, waiting)).toBe(true);
    expect(isActiveQuest(quest('old'), NOW, waiting)).toBe(false);
    expect(isActiveQuest(quest('shut', { status: 'closed', lastActivity: NOW }), NOW, waiting)).toBe(false);
  });

  it('falls back to the start time when the hub sends no last activity', () => {
    expect(isActiveQuest(quest('x', { lastActivity: undefined, createdAt: NOW - 1000 }), NOW, new Set())).toBe(true);
  });
});

describe('questTabs', () => {
  it('gives tabs to active Quests and the shown one, oldest first', () => {
    const sessions = [
      quest('new', { status: 'running', createdAt: 3 }),
      quest('old', { createdAt: 1 }),
      quest('mid', { status: 'running', createdAt: 2 }),
    ];
    const tabs = (shown: string | null) =>
      questTabs(sessions, { now: NOW, shown, waiting: new Set(), putAway: {} }).map((s) => s.id);
    expect(tabs('old')).toEqual(['old', 'mid', 'new']);
    expect(tabs(null)).toEqual(['mid', 'new']);
  });

  it('leaves out a Quest put away on this device until it has new activity, unless it needs you', () => {
    const at = NOW - 1000;
    const away = { a: at };
    const tabs = (lastActivity: number, waiting: string[] = []) =>
      questTabs([quest('a', { status: 'running', lastActivity })], {
        now: NOW,
        shown: null,
        waiting: new Set(waiting),
        putAway: away,
      });
    expect(tabs(at)).toEqual([]);
    expect(tabs(at + 1)).toHaveLength(1);
    expect(tabs(at, ['a'])).toHaveLength(1);
  });
});

describe('put-away storage', () => {
  it('remembers put-away Quests per Kingdom, and survives broken storage', () => {
    const storage = memoryStorage();
    savePutAway(putAway(loadPutAway(storage), 'k', 'a', 5), storage);
    expect(loadPutAway(storage)).toEqual({ k: { a: 5 } });
    storage.setItem('crystal-bridge.put-away', '{nope');
    expect(loadPutAway(storage)).toEqual({});
  });
});

describe('projectName', () => {
  it('is the last folder of the path', () => {
    expect(projectName('/home/me/code/crystal-bridge')).toBe('crystal-bridge');
    expect(projectName('/home/me/code/crystal-bridge/')).toBe('crystal-bridge');
  });

  it('names the repository, not the worktree, for a Quest in a worktree', () => {
    expect(projectName('/home/me/code/app/.worktrees/4f2a')).toBe('app');
    expect(projectName('/home/me/code/app/.claude/worktrees/docs-site')).toBe('app');
  });

  it('keeps what is left for a root or an empty path', () => {
    expect(projectName('/')).toBe('/');
    expect(projectName('')).toBe('');
  });
});
