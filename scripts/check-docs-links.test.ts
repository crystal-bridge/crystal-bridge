import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { findBadLinks } from './check-docs-links.mjs';

function site(files: Record<string, string>): string {
  const dist = mkdtempSync(join(tmpdir(), 'cb-docs-links-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dist, path)), { recursive: true });
    writeFileSync(join(dist, path), text);
  }
  return dist;
}

describe('the built docs site’s links', () => {
  const check = (files: Record<string, string>, base?: string) => {
    const dist = site(files);
    try {
      return findBadLinks(dist, base);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  };

  it('passes clean URLs, relative links, anchors and files', () => {
    const page = '<h2 id="top">x</h2><a href="./other#deep">a</a><a href="/other">b</a><link href="/assets/a.css">';
    assert.deepEqual(
      check({
        'index.html': page,
        'other.html': '<p id="deep"><a href="#deep">c</a><a href="./">d</a></p>',
        'assets/a.css': '',
      }),
      [],
    );
  });

  it('fails a link whose case differs from the page, as Pages would', () => {
    assert.deepEqual(check({ 'index.html': '<a href="./OTHER">a</a>', 'other.html': '' }), ['index.html: ./OTHER']);
  });

  it('fails an anchor the page doesn’t have', () => {
    const files = { 'index.html': '<a href="./other#gone">a</a>', 'other.html': '<p id="here"></p>' };
    assert.deepEqual(check(files), ['index.html: ./other#gone']);
  });

  it('checks a site served under a base path, and leaves other sites alone', () => {
    const files = {
      'index.html': '<a href="/repo/other">a</a><a href="/other">b</a><a href="https://x.dev/Y">c</a>',
      'other.html': '',
    };
    assert.deepEqual(check(files, '/repo/'), ['index.html: /other']);
  });
});
