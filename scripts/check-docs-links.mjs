#!/usr/bin/env node
/**
 * Checks every internal link and anchor in the built docs site, case-sensitively, as Pages serves it. VitePress's own
 * dead-link check compares links to source file names, so it passes a link the rewritten addresses don't have. File
 * names are compared as strings from a directory listing, so this holds on macOS too, whose filesystem hides the bug.
 *
 * Plain Node, since the docs job installs only the docs workspace. Usage: node scripts/check-docs-links.mjs [dist] [base]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

/** The built file a site path means, with the site's clean URLs, or undefined. */
function resolveFile(path, files) {
  const bare = path.replace(/^\/+|\/+$/g, '');
  const tries = bare === '' ? ['index.html'] : [bare, `${bare}.html`, `${bare}/index.html`];
  return tries.find((file) => files.has(file));
}

/** Every bad internal link in a built site, as `page: href`. */
export function findBadLinks(dist, base = '/') {
  const files = new Set(listFiles(dist).map((file) => relative(dist, file).split(sep).join('/')));
  const pages = [...files].filter((file) => file.endsWith('.html'));
  const html = new Map(pages.map((page) => [page, readFileSync(join(dist, page), 'utf8')]));
  const anchors = new Map(
    pages.map((page) => [page, new Set([...html.get(page).matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]))]),
  );

  const prefix = base.replace(/\/*$/, '/');
  const bad = [];
  for (const page of pages) {
    const pageUrl = new URL(`http://site${prefix}${page.replace(/(index)?\.html$/, '')}`);
    for (const [, href] of html.get(page).matchAll(/\shref="([^"]*)"/g)) {
      // Anything with a scheme or a host of its own is outside the site.
      if (href === '' || href === '#' || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) continue;
      const url = new URL(href, pageUrl);
      if (!url.pathname.startsWith(prefix)) {
        bad.push(`${page}: ${href}`);
        continue;
      }
      const target = resolveFile(decodeURIComponent(url.pathname.slice(prefix.length)), files);
      const anchor = decodeURIComponent(url.hash.slice(1));
      if (!target || (anchor && target.endsWith('.html') && !anchors.get(target)?.has(anchor))) {
        bad.push(`${page}: ${href}`);
      }
    }
  }
  return [...new Set(bad)];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dist = process.argv[2] ?? 'docs/.vitepress/dist';
  const base = process.argv[3] ?? process.env.DOCS_BASE ?? '/';
  const bad = findBadLinks(dist, base);
  for (const link of bad) console.error(`bad link: ${link}`);
  if (bad.length > 0) {
    console.error(`${bad.length} bad links in ${dist}`);
    process.exit(1);
  }
  console.log(`docs links: all good in ${dist}`);
}
