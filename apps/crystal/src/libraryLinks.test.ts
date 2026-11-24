import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLibrary, type Library } from './library.js';
import { createLinkIndex, linksIn } from './libraryLinks.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the link index (#290)', () => {
  it('finds wiki links and relative Markdown links, not those in code', () => {
    const text =
      'See [[Glossary]], [[ops/Release checklist|the list]] and [the path](../ops/summons.md).\n`[[not]]`\n```\n[[nor]]\n```';
    const found = linksIn(text, 'notes/a.md');
    expect(found.map((l) => l.target)).toEqual(['Glossary', 'ops/Release checklist', 'ops/summons.md']);
    expect(found.every((l) => l.line.startsWith('See [[Glossary]]'))).toBe(true);
  });

  it('answers backlinks from the index, with the linking line', async () => {
    const long = 'x'.repeat(300);
    const files: Record<string, string> = {
      'Glossary.md': '# Glossary',
      'a.md': 'one [[Glossary]] here',
      'sub/b.md': 'two [g](../Glossary.md) ' + long,
      'c.md': 'three [[glossary#Terms|terms]]',
      'd.md': 'nothing here',
    };
    const index = createLinkIndex({
      list: async () => Object.keys(files).map((path) => ({ path, kind: 'md' as const })),
      read: async (p) => files[p],
    });
    await index.rebuild();
    const back = await index.backlinks('Glossary.md');
    expect(back.map((b) => b.path)).toEqual(['a.md', 'c.md', 'sub/b.md']);
    expect(back[0]!.line).toBe('one [[Glossary]] here');
    expect(back[2]!.line.length).toBe(200);
    index.stop();
  });

  it('refreshes from changes at most once every few seconds', async () => {
    let reads = 0;
    const index = createLinkIndex({
      list: async () => [{ path: 'a.md', kind: 'md' as const }],
      read: async () => {
        reads++;
        return '[[b]]';
      },
      refreshMs: 100,
    });
    for (let i = 0; i < 10; i++) {
      index.changed(['a.md']);
      await sleep(5);
    }
    await sleep(250);
    expect(reads).toBe(1);
    index.stop();
  });

  describe('in a Library', () => {
    let base: string;
    let library: Library | undefined;
    afterEach(() => {
      library?.stop();
      rmSync(base, { recursive: true, force: true });
    });

    it('builds the index at start without blocking list()', async () => {
      base = mkdtempSync(join(tmpdir(), 'crystal-links-'));
      const dir = join(base, 'lib');
      mkdirSync(dir);
      writeFileSync(join(dir, 'Glossary.md'), 'g');
      writeFileSync(join(dir, 'a.md'), 'see [[Glossary]]');
      library = createLibrary({ dir, log: () => {} });
      await library.start();
      const listed = await library.list();
      expect(listed.ok && listed.entries.length).toBe(2);
      expect(await library.backlinks('Glossary.md')).toEqual({
        ok: true,
        backlinks: [{ path: 'a.md', line: 'see [[Glossary]]' }],
      });
      expect(await library.backlinks('../etc/passwd')).toEqual({ ok: false, reason: 'not in the Library' });
      expect(await library.backlinks('missing.md')).toEqual({ ok: false, reason: 'not in the Library' });
    });
  });
});
