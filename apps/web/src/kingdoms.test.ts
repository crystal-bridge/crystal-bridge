import { describe, expect, it } from 'vitest';
import { EMPTY_PREFS, listKingdoms, loadPrefs, notifyLevel, pickActive, savePrefs } from './kingdoms.js';

const session = (node: string) => ({
  id: `${node}-s`,
  node,
  cwd: '/w',
  label: 'l',
  status: 'running' as const,
  createdAt: 0,
});

describe('listKingdoms', () => {
  it('lists every node that is connected or has sessions, sorted, with connection state and session counts', () => {
    const { visible, hidden } = listKingdoms(
      ['node-b'],
      [session('node-a'), session('node-b'), session('node-b')],
      EMPTY_PREFS,
    );
    expect(visible).toEqual([
      { id: 'node-a', name: 'node-a', connected: false, sessions: 1 },
      { id: 'node-b', name: 'node-b', connected: true, sessions: 2 },
    ]);
    expect(hidden).toEqual([]);
  });

  it('orders tabs as this device arranged them, with new Kingdoms after', () => {
    const prefs = { names: {}, hidden: [], order: ['node-b'] };
    const { visible } = listKingdoms(['node-b', 'node-a', 'zeta'], [], prefs);
    expect(visible.map((k) => k.id)).toEqual(['node-b', 'node-a', 'zeta']);
  });

  it('uses this device-s names, and moves hidden Kingdoms out of the visible list', () => {
    const prefs = { names: { 'node-a': 'Lantern' }, hidden: ['node-a'] };
    const { visible, hidden } = listKingdoms(['node-b', 'node-a'], [], prefs);
    expect(visible.map((k) => k.id)).toEqual(['node-b']);
    expect(hidden).toEqual([{ id: 'node-a', name: 'Lantern', connected: true, sessions: 0 }]);
  });
});

describe('pickActive', () => {
  const kingdoms = [
    { id: 'a', name: 'a', connected: true, sessions: 0 },
    { id: 'b', name: 'b', connected: true, sessions: 0 },
  ];

  it('keeps the preferred Kingdom when it is visible, and falls back to the first otherwise', () => {
    expect(pickActive(kingdoms, 'b')).toBe('b');
    expect(pickActive(kingdoms, 'hidden-one')).toBe('a');
    expect(pickActive(kingdoms, undefined)).toBe('a');
    expect(pickActive([], 'a')).toBeNull();
  });
});

describe('prefs storage', () => {
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

  it('round-trips through storage', () => {
    const storage = memoryStorage();
    const prefs = {
      names: { 'node-a': 'Lantern' },
      hidden: ['node-a'],
      active: 'node-b',
      order: ['node-b', 'node-a'],
      questOrder: { 'node-b': ['s2', 's1'] },
    };
    savePrefs(prefs, storage);
    expect(loadPrefs(storage)).toEqual(prefs);
  });

  it('falls back to empty prefs when storage is missing, throws, or holds junk', () => {
    expect(loadPrefs(undefined)).toEqual(EMPTY_PREFS);
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    expect(loadPrefs(throwing)).toEqual(EMPTY_PREFS);
    expect(() => savePrefs(EMPTY_PREFS, throwing)).not.toThrow();
    const junk = memoryStorage();
    junk.setItem('crystal-bridge.kingdoms', '{"names": 5}');
    expect(loadPrefs(junk)).toEqual(EMPTY_PREFS);
  });
});

describe('notification levels', () => {
  it('defaults to full, and reads this device-s choice per Kingdom', () => {
    expect(notifyLevel({ ...EMPTY_PREFS }, 'node-a')).toBe('full');
    expect(notifyLevel({ ...EMPTY_PREFS, notify: { 'node-a': 'discreet' } }, 'node-a')).toBe('discreet');
  });
});
