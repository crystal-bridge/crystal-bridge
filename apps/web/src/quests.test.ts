import { describe, expect, it } from 'vitest';
import type { SessionSummary } from './components/SessionList.js';
import {
  byAttention,
  isActiveQuest,
  loadPutAway,
  projectName,
  putAway,
  questName,
  questTitle,
  questTabs,
  RECENT_MS,
  savePutAway,
} from './quests.js';

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

  it('counts a finished Quest you have not seen, however old', () => {
    expect(isActiveQuest(quest('u'), NOW, new Set(['u']))).toBe(true);
  });

  it('falls back to the start time when the hub sends no last activity', () => {
    expect(isActiveQuest(quest('x', { lastActivity: undefined, createdAt: NOW - 1000 }), NOW, new Set())).toBe(true);
  });
});

describe('byAttention', () => {
  it('puts what needs you first, then finished and unseen, then working, then idle, newest first in each', () => {
    const sessions = [
      quest('idle-new', { lastActivity: NOW - 10 * 60_000 }),
      quest('working', { status: 'running', lastActivity: NOW - 1_000 }),
      quest('unseen-old', { lastActivity: NOW - 3 * RECENT_MS }),
      quest('needs-you', { lastActivity: NOW - 2 * RECENT_MS }),
      quest('unseen-new', { lastActivity: NOW - 5_000 }),
      quest('idle-old'),
      quest('running-quiet', { status: 'running', lastActivity: NOW - 60 * 60_000 }),
    ];
    const order = byAttention(sessions, {
      now: NOW,
      waiting: new Set(['needs-you']),
      unseen: new Set(['unseen-old', 'unseen-new']),
    }).map((s) => s.id);
    expect(order).toEqual([
      'needs-you',
      'unseen-new',
      'unseen-old',
      'working',
      'idle-new',
      'running-quiet',
      'idle-old',
    ]);
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

describe('questName', () => {
  const quest = { id: 'q1', label: 'Fix the smoke test', themedLabel: 'The Siege of Smoke' };

  it('shows the name in the theme’s voice when the Quest gave one, and the plain one in the Classic theme', () => {
    expect(questName(quest, true)).toBe('The Siege of Smoke');
    expect(questName(quest, false)).toBe('Fix the smoke test');
  });

  it('falls back to the plain name, then the id', () => {
    expect(questName({ id: 'q1', label: 'Fix it' }, true)).toBe('Fix it');
    expect(questName({ id: 'q1', label: '' }, true)).toBe('q1');
  });
});

describe('questTitle', () => {
  const quest: SessionSummary = { id: 'q1', node: 'k', cwd: '/r/app', label: 'Fix it', status: 'idle', createdAt: 1 };

  it('says when the Quest named itself, in the theme’s words', () => {
    expect(questTitle({ ...quest, themedLabel: 'The Siege', titledBy: 'quest' })).toContain(
      'The Bard named this Quest',
    );
    expect(questTitle({ ...quest, titledBy: 'you' })).not.toContain('Bard');
    expect(questTitle(quest)).not.toContain('Bard');
  });
});
