/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Read from disk: the test runner hands CSS imports over empty, `?raw` included.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const THEME = read('../theme/theme.css');
const HIGHLIGHT = read('./tomeHighlight.css');

const DARK = '@media (prefers-color-scheme: dark) {';

/** The custom properties a stylesheet sets: those inside a dark-scheme block, and the rest. */
function tokens(css: string): { light: Set<string>; dark: Set<string> } {
  let rest = css;
  const darkCss: string[] = [];
  for (let at = rest.indexOf(DARK); at >= 0; at = rest.indexOf(DARK)) {
    let depth = 1;
    let end = at + DARK.length;
    while (depth > 0 && end < rest.length) {
      if (rest[end] === '{') depth += 1;
      if (rest[end] === '}') depth -= 1;
      end += 1;
    }
    darkCss.push(rest.slice(at, end));
    rest = rest.slice(0, at) + rest.slice(end);
  }
  const names = (text: string) => new Set([...text.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]!));
  return { light: names(rest), dark: names(darkCss.join('\n')) };
}

describe("a Tome's code colours (theme tokens, docs/THEME.md)", () => {
  it('hold no colours of their own', () => {
    expect(HIGHLIGHT.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/#[0-9a-f]{3,8}\b|rgb|hsl|oklch/i);
    expect(HIGHLIGHT).not.toMatch(/prefers-color-scheme/);
  });

  it('read --tome-code-* tokens that theme.css sets for light and dark', () => {
    const used = [...new Set([...HIGHLIGHT.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1]!))];
    expect(used.length).toBeGreaterThan(0);
    const { light, dark } = tokens(THEME);
    for (const token of used) {
      expect(token).toMatch(/^--tome-code-/);
      expect(light.has(token), `${token} in :root`).toBe(true);
      expect(dark.has(token), `${token} in the dark block`).toBe(true);
    }
  });
});
