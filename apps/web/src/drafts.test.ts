import { describe, expect, it } from 'vitest';
import { loadDraft, saveDraft } from './drafts.js';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  };
}

describe('drafts', () => {
  it('keeps unsent text per key, and forgets it once emptied', () => {
    const storage = memoryStorage();
    expect(loadDraft('new:node-a', storage)).toBe('');
    saveDraft('new:node-a', 'half a prompt', storage);
    saveDraft('quest:q1', 'a follow-up', storage);
    expect(loadDraft('new:node-a', storage)).toBe('half a prompt');
    expect(loadDraft('quest:q1', storage)).toBe('a follow-up');
    saveDraft('new:node-a', '', storage);
    expect(loadDraft('new:node-a', storage)).toBe('');
    expect(storage.length).toBe(1);
  });

  it('works without storage (a private window that throws)', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    expect(() => saveDraft('k', 'x', broken)).not.toThrow();
    expect(loadDraft('k', broken)).toBe('');
  });
});
