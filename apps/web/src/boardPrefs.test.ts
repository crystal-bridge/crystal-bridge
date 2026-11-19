import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBoardMode, useFolded } from './boardPrefs.js';

// Each test uses its own Kingdom id: the page fallback is module state and outlives a storage clear.
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('useBoardMode', () => {
  it('starts on projects, switches to tiles, and is saved for the same Board only', () => {
    const first = renderHook(() => useBoardMode('mode-a', 'github'));
    expect(first.result.current[0]).toBe('projects');
    act(() => first.result.current[1]('tiles'));
    expect(first.result.current[0]).toBe('tiles');

    const second = renderHook(() => useBoardMode('mode-a', 'github'));
    expect(second.result.current[0]).toBe('tiles');
    expect(localStorage.getItem('crystal-bridge.board-mode.mode-a.github')).toBe('tiles');

    expect(renderHook(() => useBoardMode('mode-a', 'gmail')).result.current[0]).toBe('projects');
    expect(renderHook(() => useBoardMode('mode-b', 'github')).result.current[0]).toBe('projects');
  });

  it('reads an unknown saved value as projects', () => {
    localStorage.setItem('crystal-bridge.board-mode.mode-c.github', 'grid');
    expect(renderHook(() => useBoardMode('mode-c', 'github')).result.current[0]).toBe('projects');
  });

  it('holds the choice for the page when storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    const hook = renderHook(() => useBoardMode('mode-d', 'github'));
    act(() => hook.result.current[1]('tiles'));
    expect(hook.result.current[0]).toBe('tiles');
  });
});

describe('useFolded', () => {
  it('toggles a project in and out, and saves it', () => {
    const hook = renderHook(() => useFolded('fold-a', 'github'));
    expect(hook.result.current[0].size).toBe(0);
    act(() => hook.result.current[1]('alpha'));
    expect(hook.result.current[0].has('alpha')).toBe(true);
    expect(JSON.parse(localStorage.getItem('crystal-bridge.board-folds.fold-a.github')!)).toEqual(['alpha']);
    expect(renderHook(() => useFolded('fold-a', 'github')).result.current[0].has('alpha')).toBe(true);
    act(() => hook.result.current[1]('alpha'));
    expect(hook.result.current[0].has('alpha')).toBe(false);
  });

  it('reads a corrupt saved value as empty', () => {
    for (const [i, bad] of ['{oops', '{"a":1}', '[1,2]'].entries()) {
      localStorage.setItem(`crystal-bridge.board-folds.fold-b${i}.github`, bad);
      expect(renderHook(() => useFolded(`fold-b${i}`, 'github')).result.current[0].size).toBe(0);
    }
  });

  it('holds the folds for the page when storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    const hook = renderHook(() => useFolded('fold-c', 'github'));
    act(() => hook.result.current[1]('alpha'));
    expect(hook.result.current[0].has('alpha')).toBe(true);
  });
});
