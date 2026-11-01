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

  it('answers the one-machine question, and the home page leads to the answer', () => {
    const start = readFileSync(join(DOCS, 'GETTING-STARTED.md'), 'utf8');
    assert.match(start, /^## Can I use this on one machine\?$/m);
    assert.match(home, /GETTING-STARTED\.md#can-i-use-this-on-one-machine/);
    for (const heading of [
      'Try it',
      'Keep it running on this computer',
      'Reach it from another device',
      'On Windows',
    ]) {
      assert.ok(start.includes(`\n## ${heading}\n`), `Getting started has no "${heading}"`);
    }
  });

  it('lets a reader with no checkout follow the steps', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const steps = /#region one-machine -->([\s\S]*?)<!-- #endregion one-machine/.exec(readme)?.[1] ?? '';
    assert.match(steps, /git clone /);
    assert.match(steps, /npm install -g pnpm/);
  });

  it('points at the demo', () => {
    assert.match(home, /pnpm demo/);
    assert.match(readFileSync(join(DOCS, 'GETTING-STARTED.md'), 'utf8'), /pnpm demo/);
  });

  it('files Summons under running it, as the feature it is', () => {
    const run = config.slice(config.indexOf("text: 'Run it'"), config.indexOf("text: 'Keep it safe'"));
    assert.ok(run.includes("link: '/summons'"));
  });

  it('marks nothing that has shipped as planned', () => {
    assert.doesNotMatch(readFileSync(join(DOCS, 'THEME.md'), 'utf8'), /\(planned\)/);
  });

  it('opens with what it is, something to look at, and the way into the concepts', () => {
    assert.match(home, /src: \/logo\.svg/);
    assert.match(home, /TourSwitch/);
    assert.match(home, /link: \/concepts/);
  });

  describe('the tour', () => {
    const tour = readFileSync(join(DOCS, '.vitepress/theme/TourSwitch.vue'), 'utf8');

    it('is on the home page, by way of the switch', () => {
      assert.match(home, /<TourSwitch \/>/);
    });

    it('shows the themed version until a reader asks for the plain one', () => {
      assert.match(tour, /const plain = ref\(false\)/);
      assert.match(tour, /import themedGif from '..\/..\/images\/demo.gif'/);
      assert.match(tour, /import plainGif from '..\/..\/images\/demo-plain.gif'/);
      // Nothing may name the plain file in markup, or a browser would fetch it with the page.
      assert.doesNotMatch(tour, /rel="preload"|<img[^>]*plainGif/);
    });

    it('gives each version its own words', () => {
      assert.match(tour, /Quest/);
      assert.doesNotMatch(
        tour.slice(tour.indexOf('const PLAIN'), tour.indexOf('const shown')),
        /Quest|Kingdom|Airship/,
      );
    });

    it('leaves the README with the themed one alone, which can’t hold a switch', () => {
      const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
      assert.match(readme, /docs\/images\/demo\.gif/);
      assert.doesNotMatch(readme, /demo-plain/);
    });
  });
});
