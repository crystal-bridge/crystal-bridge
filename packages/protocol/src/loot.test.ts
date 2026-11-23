import { describe, expect, it } from 'vitest';
import { lootPath, lootPaths, trophyLinks } from './loot.js';

const assistant = (...blocks: Array<{ name: string; input: Record<string, unknown> }>) => ({
  type: 'assistant',
  message: { content: blocks.map((b, i) => ({ type: 'tool_use', id: `t${i}`, ...b })) },
});
const result = (content: unknown) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: 't0', content }] },
});

describe('Loot and Trophies (#289)', () => {
  it("finds the paths a raw line's file tools wrote", () => {
    const raw = assistant(
      { name: 'Write', input: { file_path: '/r/lantern/a.ts' } },
      { name: 'Edit', input: { file_path: 'b.ts' } },
      { name: 'NotebookEdit', input: { notebook_path: '/r/lantern/n.ipynb' } },
      { name: 'Read', input: { file_path: 'c.ts' } },
    );
    expect(lootPaths(raw)).toEqual(['/r/lantern/a.ts', 'b.ts', '/r/lantern/n.ipynb']);
    expect(lootPaths({ type: 'user', message: { content: [] } })).toEqual([]);
  });

  it("makes a path relative to the Quest's folder when it's inside it", () => {
    expect(lootPath('/r/lantern/a.ts', '/r/lantern')).toBe('a.ts');
    expect(lootPath('/r/other/a.ts', '/r/lantern')).toBe('/r/other/a.ts');
    expect(lootPath('a.ts', undefined)).toBe('a.ts');
  });

  it('finds pull request links printed alone on a line, once each, without a trailing slash', () => {
    const text = 'Created\nhttps://example.com/acme/lantern/pull/319/\n';
    expect(trophyLinks(result(text))).toEqual(['https://example.com/acme/lantern/pull/319']);
    expect(trophyLinks(result([{ type: 'text', text }]))).toEqual(['https://example.com/acme/lantern/pull/319']);
    expect(trophyLinks(result(`${text}${text}`))).toEqual(['https://example.com/acme/lantern/pull/319']);
    expect(trophyLinks(result('see https://example.com/acme/lantern/pull/1 for details'))).toEqual([]);
    expect(trophyLinks(result('fixed in https://example.com/acme/lantern/merge_requests/7 today'))).toEqual([]);
    expect(trophyLinks(result('https://example.com/acme/lantern/merge_requests/7'))).toEqual([
      'https://example.com/acme/lantern/merge_requests/7',
    ]);
  });
});
