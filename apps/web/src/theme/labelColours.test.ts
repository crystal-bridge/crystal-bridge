import { describe, expect, it } from 'vitest';
import { LABEL_SURFACES, labelColours, labelTint } from './labelColours.js';
import { contrast } from './promptColours.js';

const GITHUB_DEFAULTS = [
  '#d73a4a',
  '#0075ca',
  '#cfd3d7',
  '#a2eeef',
  '#7057ff',
  '#008672',
  '#e4e669',
  '#d876e3',
  '#ffffff',
];
const EXTRA = ['#000000', '#fef2c0', '#c2e0c6', '#bfd4f2', '#b60205', '#5319e7', '#fbca04'];

describe('label colours', () => {
  describe.each(['light', 'dark'] as const)('in the %s theme', (theme) => {
    it.each([...GITHUB_DEFAULTS, ...EXTRA])('%s text reaches 4.5:1 on its pill, on every row shade', (color) => {
      const text = labelColours(color)[theme];
      for (const surface of LABEL_SURFACES[theme]) {
        expect(contrast(text, labelTint(color, surface))).toBeGreaterThanOrEqual(4.5);
      }
    });
  });

  it('keeps the label colour as the text hue where it already reads', () => {
    expect(labelColours('#0075ca').light).not.toBe('#000000');
    expect(labelColours('#ffffff').dark).toBe('#ffffff');
  });
});
