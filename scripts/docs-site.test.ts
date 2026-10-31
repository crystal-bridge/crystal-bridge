import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/** The site's own build catches dead links. This holds the things a dead-link check can't see. */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS = join(ROOT, 'docs');
const config = readFileSync(join(DOCS, '.vitepress/config.ts'), 'utf8');
const home = readFileSync(join(DOCS, 'index.md'), 'utf8');

describe('docs site', () => {
  it('reaches every page from the sidebar', () => {
    const pages = readdirSync(DOCS).filter((file) => file.endsWith('.md') && file !== 'index.md');
    for (const page of pages) {
      const link = `link: '/${page.replace(/\.md$/, '').toLowerCase()}'`;
      assert.ok(config.includes(link), `${page} is missing from the sidebar`);
    }
  });

  it('orders the sidebar the way a new reader needs it', () => {
    const order = ['/concepts', '/getting-started', '/several-machines', '/configuration', '/contributing'];
    const places = order.map((link) => config.indexOf(`link: '${link}'`, config.indexOf('sidebar:')));
    assert.deepEqual(
      places,
      [...places].sort((a, b) => a - b),
    );
  });

  it('builds the favicon link from the base path, which a head entry does not get on its own', () => {
    assert.match(config, /rel: 'icon'[^\]]*href: `\$\{BASE\}logo\.svg`/);
  });

  it('keeps its logo the same as the app’s crystal', () => {
    const logo = readFileSync(join(DOCS, 'public/logo.svg'), 'utf8');
    assert.equal(logo, readFileSync(join(ROOT, 'apps/web/public/favicon.svg'), 'utf8'));
  });

  it('opens with what it is, something to look at, and the way into the concepts', () => {
    assert.match(home, /src: \/logo\.svg/);
    assert.match(home, /demo\.gif/);
    assert.match(home, /link: \/concepts/);
  });
});
