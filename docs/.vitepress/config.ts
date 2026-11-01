import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const { repository } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { repository: { url: string } };
/** Actions names the repository it runs in, so a fork links to itself; a local build falls back on package.json. */
const SLUG = process.env.GITHUB_REPOSITORY ?? /github\.com\/(.+?)(\.git)?$/.exec(repository.url)?.[1];
const REPO = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${SLUG}`;

// Where Pages serves this repository: the workflow works it out, so no org or repository name lives here.
const BASE = process.env.DOCS_BASE ?? '/';

export default defineConfig({
  title: 'Crystal Bridge',
  description: 'Every Claude Code session on every machine, in one web app.',
  base: BASE,
  // VitePress adds the base to the theme's links, but not to a `head` entry.
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: `${BASE}logo.svg` }]],
  cleanUrls: true,
  // The one exception to failing on a dead link: the local app that the getting-started steps open.
  ignoreDeadLinks: 'localhostLinks',
  // The pages keep their file names, which the code and README refer to; only their addresses are lower case.
  rewrites: (id) => id.toLowerCase(),
  markdown: {
    config(md) {
      // A link out of docs/ works when read on GitHub; on the site it goes to the same file there, if it exists.
      const render = md.renderer.rules.link_open!;
      md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
        const link = tokens[idx]!;
        const href = link.attrGet('href');
        if (href?.startsWith('../')) {
          const [path = '', anchor] = href.slice('../'.length).split('#');
          if (!existsSync(join(ROOT, path))) throw new Error(`dead link: ${href} in ${env.relativePath}`);
          link.attrSet('href', `${REPO}/blob/HEAD/${path}${anchor ? `#${anchor}` : ''}`);
        }
        return render(tokens, idx, options, env, self);
      };
    },
  },
  themeConfig: {
    logo: '/logo.svg',
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: REPO }],
    sidebar: [
      {
        text: 'Start here',
        items: [
          { text: 'How it fits together', link: '/concepts' },
          { text: 'Getting started on one machine', link: '/getting-started' },
          { text: 'Several machines', link: '/several-machines' },
          { text: 'Install the app', link: '/install-app' },
        ],
      },
      {
        text: 'Run it',
        items: [
          { text: 'Configuration reference', link: '/configuration' },
          { text: 'Operations', link: '/operations' },
        ],
      },
      {
        text: 'Keep it safe',
        items: [
          { text: 'Security model', link: '/security-model' },
          { text: 'What Crystal Bridge stores', link: '/hub-data' },
        ],
      },
      {
        text: 'Change it',
        items: [
          { text: 'Themes and art packs', link: '/theme' },
          { text: 'Engines and the protocol', link: '/engines' },
          { text: 'Summons design', link: '/summons' },
          { text: 'Contributing', link: '/contributing' },
        ],
      },
    ],
  },
});
