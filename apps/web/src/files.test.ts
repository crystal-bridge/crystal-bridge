import { describe, expect, it } from 'vitest';
import { fileHref, isMarkdown, languageOf, pathIn } from './files.js';

describe('pathIn', () => {
  it('finds a file path in inline code, without a trailing line number', () => {
    expect(pathIn('docs/OPEN-SOURCE.md')).toBe('docs/OPEN-SOURCE.md');
    expect(pathIn('apps/web/src/App.tsx:42')).toBe('apps/web/src/App.tsx');
    expect(pathIn('/Users/me/code/repo/README.md')).toBe('/Users/me/code/repo/README.md');
    expect(pathIn('package.json')).toBe('package.json');
    expect(pathIn('Dockerfile')).toBe('Dockerfile');
  });

  it('leaves code that is not a file alone', () => {
    for (const text of [
      'pnpm test',
      'session.start',
      '/api/sessions',
      'https://example.com/a.md',
      'a.b()',
      'x',
      'apps/web/src',
    ]) {
      expect(pathIn(text), text).toBeUndefined();
    }
  });
});

describe('fileHref', () => {
  it('treats relative link targets that look like files as files, and anything with a scheme as a web link', () => {
    expect(fileHref('docs/HANDOFF.md')).toBe('docs/HANDOFF.md');
    expect(fileHref('./docs/HANDOFF.md#rules')).toBe('docs/HANDOFF.md');
    for (const href of ['https://example.com/x.md', 'mailto:a@b.c', '#top', '//cdn/x.js', undefined]) {
      expect(fileHref(href), String(href)).toBeUndefined();
    }
  });
});

describe('languageOf / isMarkdown', () => {
  it('names a file-s language from its extension', () => {
    expect(languageOf('a/b.ts')).toBe('ts');
    expect(languageOf('Dockerfile')).toBe('dockerfile');
    expect(languageOf('notes')).toBeUndefined();
    expect(isMarkdown('README.md')).toBe(true);
    expect(isMarkdown('a.mdx')).toBe(true);
    expect(isMarkdown('a.ts')).toBe(false);
  });
});
