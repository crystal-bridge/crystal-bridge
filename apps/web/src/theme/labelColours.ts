import { contrast } from './promptColours.js';

/**
 * A label pill's text colour, worked out from the label's own colour. The pill is the label colour at 16% over the row,
 * and its text starts as the colour shaded 45% toward black (light theme) or 35% toward white (dark) and keeps shading
 * until it reaches WCAG AA, 4.5:1, so a pale or a near-black label stays readable. A test checks it.
 */
export type LabelTheme = 'light' | 'dark';

/** The row backgrounds a pill can sit on: the card and its hover shade, in each theme. */
export const LABEL_SURFACES: Record<LabelTheme, readonly string[]> = {
  light: ['#ffffff', '#fafafa'],
  dark: ['#171717', '#262626'],
};

/** How much of the label colour the pill's background keeps. */
const TINT = 0.16;

const channels = (hex: string): number[] => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
const toHex = (rgb: number[]): string => `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;

function mix(a: string, b: string, share: number): string {
  const [x, y] = [channels(a), channels(b)];
  return toHex(x.map((c, at) => c * share + y[at]! * (1 - share)));
}

/** The pill's background colour: the label colour at 16% over a row's background. */
export const labelTint = (color: string, surface: string): string => mix(color, surface, TINT);

/** The pill's text colour in each theme, never below 4.5:1 on any row shade. */
export function labelColours(color: string): Record<LabelTheme, string> {
  const pick = (theme: LabelTheme): string => {
    const toward = theme === 'light' ? '#000000' : '#ffffff';
    for (let shade = theme === 'light' ? 0.45 : 0.35; shade < 1; shade += 0.05) {
      const text = mix(toward, color, shade);
      if (LABEL_SURFACES[theme].every((surface) => contrast(text, labelTint(color, surface)) >= 4.5)) return text;
    }
    return toward;
  };
  return { light: pick('light'), dark: pick('dark') };
}
