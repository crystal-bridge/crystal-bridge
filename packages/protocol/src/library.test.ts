import { describe, expect, it } from 'vitest';
import { ClientMessage, HubToClient, NodeHello } from './commands.js';
import {
  HubLibraryBacklinks,
  HubLibraryList,
  HubLibraryRead,
  HubLibraryWrite,
  MAX_TOME_BYTES,
  NodeLibraryAnswer,
  NodeLibraryChanged,
  parseWikiLink,
  resolveWikiLink,
} from './library.js';

const requestId = '6f1c1b0e-5a3d-4f5e-9d57-0c1f2f3a4b5c';
const version = { size: 5, mtimeMs: 1, hash: 'a'.repeat(64) };

describe('the Library (#290)', () => {
  it('takes the four requests', () => {
    const list = { kind: 'library-list', requestId };
    expect(HubLibraryList.parse(list)).toEqual(list);
    const read = { kind: 'library-read', requestId, path: 'ops/summons.md' };
    expect(HubLibraryRead.parse(read)).toEqual(read);
    expect(HubLibraryRead.parse({ ...read, as: 'image' })).toEqual({ ...read, as: 'image' });
    const write = { kind: 'library-write', requestId, path: 'ops/summons.md', content: '# Hi\n', base: null };
    expect(HubLibraryWrite.parse(write)).toEqual(write);
    expect(HubLibraryWrite.parse({ ...write, base: version })).toEqual({ ...write, base: version });
    const back = { kind: 'library-backlinks', requestId, path: 'ops/summons.md' };
    expect(HubLibraryBacklinks.parse(back)).toEqual(back);
  });

  it('refuses an empty path, a path over 1024 characters and content over 512 KB', () => {
    const read = { kind: 'library-read', requestId };
    expect(HubLibraryRead.safeParse({ ...read, path: '' }).success).toBe(false);
    expect(HubLibraryRead.safeParse({ ...read, path: 'a'.repeat(1025) }).success).toBe(false);
    const write = { kind: 'library-write', requestId, path: 'a.md', base: null };
    expect(HubLibraryWrite.safeParse({ ...write, content: 'a'.repeat(MAX_TOME_BYTES) }).success).toBe(true);
    expect(HubLibraryWrite.safeParse({ ...write, content: 'a'.repeat(MAX_TOME_BYTES + 1) }).success).toBe(false);
    // measured in bytes, not characters
    expect(HubLibraryWrite.safeParse({ ...write, content: 'é'.repeat(MAX_TOME_BYTES / 2 + 1) }).success).toBe(false);
  });

  it('answers each', () => {
    const answers = [
      {
        kind: 'library-answer',
        requestId,
        ok: true,
        entries: [
          { path: 'ops', kind: 'folder' },
          { path: 'ops/summons.md', kind: 'md', size: 2400, mtimeMs: 1 },
        ],
        truncated: true,
      },
      {
        kind: 'library-answer',
        requestId,
        ok: true,
        tome: { path: 'a.md', kind: 'md', content: '# A', encoding: 'utf8', truncated: false, version },
      },
      { kind: 'library-answer', requestId, ok: true, version },
      { kind: 'library-answer', requestId, ok: false, reason: 'changed', version },
      {
        kind: 'library-answer',
        requestId,
        ok: true,
        backlinks: [{ path: 'a.md', line: 'step 6: check that [[How Summons reach a target]]' }],
      },
    ];
    for (const a of answers) expect(NodeLibraryAnswer.parse(a)).toEqual(a);
    expect(
      NodeLibraryAnswer.safeParse({ kind: 'library-answer', requestId, ok: false, reason: 'x'.repeat(301) }).success,
    ).toBe(false);
  });

  it('says what changed', () => {
    const some = { kind: 'library-changed', paths: ['a.md'] };
    expect(NodeLibraryChanged.parse(some)).toEqual(some);
    const all = { kind: 'library-changed', all: true };
    expect(NodeLibraryChanged.parse(all)).toEqual(all);
    const many = Array.from({ length: 201 }, (_, i) => `${i}.md`);
    expect(NodeLibraryChanged.safeParse({ kind: 'library-changed', paths: many }).success).toBe(false);
  });

  it('tells clients what changed and lets them watch', () => {
    const changed = { kind: 'library-changed', node: 'node-a', paths: ['a.md'] };
    expect(HubToClient.parse(changed)).toEqual(changed);
    const watch = { kind: 'library-watch', node: 'node-a', open: true };
    expect(ClientMessage.parse(watch)).toEqual(watch);
  });

  it('a Kingdom says where its Library is', () => {
    const hello = { kind: 'hello', node: 'node-a', library: { dir: '/w/library' } };
    expect(NodeHello.parse(hello).library).toEqual({ dir: '/w/library' });
  });

  it('resolves wiki links the way Obsidian does', () => {
    const paths = [
      'ops/Release checklist.md',
      'Glossary.md',
      'old/Glossary.md',
      'sketches/retry-curve.html',
      'img/flow.png',
    ];
    expect(resolveWikiLink('Glossary', paths)).toBe('Glossary.md');
    expect(resolveWikiLink('old/Glossary', paths)).toBe('old/Glossary.md');
    expect(resolveWikiLink('release checklist', paths)).toBe('ops/Release checklist.md');
    expect(resolveWikiLink('retry-curve.html', paths)).toBe('sketches/retry-curve.html');
    expect(resolveWikiLink('flow.png', paths)).toBe('img/flow.png');
    expect(resolveWikiLink('Missing', paths)).toBeUndefined();
    expect(parseWikiLink('Page#Heading|label')).toEqual({ target: 'Page', heading: 'Heading', label: 'label' });
    expect(parseWikiLink('Page')).toEqual({ target: 'Page' });
  });
});
