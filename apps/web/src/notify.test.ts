import { describe, expect, it } from 'vitest';
import { isLooking } from './notify.js';

const page = (visibilityState: 'visible' | 'hidden', focused: boolean) => ({
  visibilityState,
  hasFocus: () => focused,
});

describe('isLooking', () => {
  it('is true only for the shown session in a visible, focused window', () => {
    expect(isLooking('s1', 's1', page('visible', true))).toBe(true);
  });

  it('is false when the window is visible but another app has focus', () => {
    // macOS Chrome reports a window behind another app as visible.
    expect(isLooking('s1', 's1', page('visible', false))).toBe(false);
  });

  it('is false for a hidden window or another session', () => {
    expect(isLooking('s1', 's1', page('hidden', true))).toBe(false);
    expect(isLooking('s2', 's1', page('visible', true))).toBe(false);
    expect(isLooking(null, 's1', page('visible', true))).toBe(false);
  });
});
