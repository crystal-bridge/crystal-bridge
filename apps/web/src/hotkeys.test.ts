import { describe, expect, it } from 'vitest';
import { HOTKEYS, hotkeyFor, hotkeyText, needsYouNext, step } from './hotkeys.js';

const press = (code: string, extra: Partial<KeyboardEvent> = {}) =>
  new KeyboardEvent('keydown', { code, altKey: true, ...extra });

describe('the key table', () => {
  it('has no duplicates', () => {
    const keys = HOTKEYS.map((key) => `${key.shift ? 'shift+' : ''}${key.code}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('leaves the Belt-s Alt+1-8 and the tabs- Alt+arrows alone', () => {
    for (const key of HOTKEYS) {
      expect(key.code).not.toMatch(/^Arrow/);
      if (/^Digit/.test(key.code)) expect(key.shift).toBe(true);
    }
  });

  it('never takes Chrome-s Alt+D, Alt+E or Alt+F', () => {
    expect(HOTKEYS.map((key) => key.code)).not.toEqual(expect.arrayContaining(['KeyD']));
    expect(HOTKEYS.map((key) => key.code)).not.toEqual(expect.arrayContaining(['KeyE']));
    expect(HOTKEYS.map((key) => key.code)).not.toEqual(expect.arrayContaining(['KeyF']));
  });
});

describe('hotkeyFor', () => {
  it('reads letters by position, so a Mac-s Option character still counts', () => {
    expect(hotkeyFor(press('KeyJ', { key: '∆' }))?.action).toBe('next-quest');
  });

  it('tells Shift apart', () => {
    expect(hotkeyFor(press('KeyJ', { shiftKey: true }))?.action).toBe('next-kingdom');
    expect(hotkeyFor(press('Digit3', { shiftKey: true }))).toMatchObject({ action: 'kingdom', index: 2 });
    expect(hotkeyFor(press('Digit3'))).toBeUndefined();
  });

  it('needs Alt, and only Alt', () => {
    expect(hotkeyFor(press('KeyJ', { altKey: false }))).toBeUndefined();
    expect(hotkeyFor(press('KeyJ', { ctrlKey: true }))).toBeUndefined();
    expect(hotkeyFor(press('KeyJ', { metaKey: true }))).toBeUndefined();
  });

  it('stands down during IME composition and on AltGr', () => {
    expect(hotkeyFor(press('KeyJ', { isComposing: true }))).toBeUndefined();
    const altGr = press('KeyJ');
    altGr.getModifierState = (key) => key === 'AltGraph';
    expect(hotkeyFor(altGr)).toBeUndefined();
  });
});

describe('step', () => {
  const ids = ['a', 'b', 'c'];

  it('moves along the list and wraps at both ends', () => {
    expect(step(ids, 'a', 1)).toBe('b');
    expect(step(ids, 'c', 1)).toBe('a');
    expect(step(ids, 'a', -1)).toBe('c');
  });

  it('starts at the matching end when nothing in the list is current', () => {
    expect(step(ids, null, 1)).toBe('a');
    expect(step(ids, null, -1)).toBe('c');
    expect(step(ids, 'gone', 1)).toBe('a');
  });

  it('has nowhere to go in an empty list', () => {
    expect(step([], 'a', 1)).toBeUndefined();
  });
});

describe('needsYouNext', () => {
  const quest = (id: string, node: string, lastActivity: number) => ({ id, node, lastActivity, createdAt: 0 });

  it('takes the oldest waiting Quest on any shown Kingdom', () => {
    const quests = [quest('new', 'a', 30), quest('old', 'b', 10), quest('mid', 'a', 20)];
    const waiting = { new: 'a', old: 'b', mid: 'a' };
    expect(needsYouNext(waiting, quests, new Set(['a', 'b']))).toEqual({ node: 'b', session: 'old' });
  });

  it('skips a hidden Kingdom', () => {
    const quests = [quest('old', 'hidden', 10), quest('new', 'a', 30)];
    expect(needsYouNext({ old: 'hidden', new: 'a' }, quests, new Set(['a']))).toEqual({ node: 'a', session: 'new' });
  });

  it('skips a Quest it knows nothing about, and finds nothing when none wait', () => {
    expect(needsYouNext({ gone: 'a' }, [], new Set(['a']))).toBeUndefined();
    expect(needsYouNext({}, [quest('a', 'a', 1)], new Set(['a']))).toBeUndefined();
  });
});

describe('hotkeyText', () => {
  it('names a key as this platform writes it', () => {
    const key = HOTKEYS.find((entry) => entry.action === 'next-kingdom')!;
    expect(hotkeyText(key, false)).toBe('Alt+Shift+J');
    expect(hotkeyText(key, true)).toBe('⌥⇧J');
    expect(
      hotkeyText(
        HOTKEYS.find((entry) => entry.action === 'keys')!,
        false,
      ),
    ).toBe('Alt+/');
  });
});
