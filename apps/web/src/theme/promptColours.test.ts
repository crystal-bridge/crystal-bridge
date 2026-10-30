import { describe, expect, it } from 'vitest';
import { contrast, DEFAULT_PROMPT_COLOUR, PROMPT_COLOURS } from './promptColours.js';

describe('prompt colours', () => {
  it('measures contrast the way WCAG does', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrast('#2563eb', '#ffffff')).toBeCloseTo(5.17, 1);
  });

  it.each(PROMPT_COLOURS)('$label is readable: at least 4.5:1, WCAG AA', ({ background, text }) => {
    expect(contrast(background, text)).toBeGreaterThanOrEqual(4.5);
  });

  it('defaults to something other than the blue that means "look here"', () => {
    expect(DEFAULT_PROMPT_COLOUR).not.toBe('blue');
    expect(PROMPT_COLOURS.map((c) => c.id)).toContain(DEFAULT_PROMPT_COLOUR);
    expect(PROMPT_COLOURS.map((c) => c.id)).toContain('blue');
  });
});
