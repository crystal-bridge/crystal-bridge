import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const { repository } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { repository: { url: string } };
/** Actions names the repository it runs in, so a fork links to itself; a local build falls back on package.json. */
const SLUG = process.env.GITHUB_REPOSITORY ?? /github\.com\/(.+?)(\.git)?$/.exec(repository.url)?.[1];
const REPO = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${SLUG}`;

export default defineConfig({
  title: 'Crystal Bridge',
  description: 'Start, watch and approve coding-agent sessions across machines.',
  // Where Pages serves this repository: the workflow works it out, so no org or repository name lives here.
  base: process.env.DOCS_BASE ?? '/',
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
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: REPO }],
    sidebar: [
      { text: 'Getting started on one machine', link: '/getting-started' },
      { text: 'Several machines', link: '/several-machines' },
      { text: 'Configuration reference', link: '/configuration' },
      { text: 'Operations', link: '/operations' },
      {
        text: 'Security model',
        link: '/security-model',
        items: [{ text: 'What Crystal Bridge stores', link: '/hub-data' }],
      },
      { text: 'Themes and art packs', link: '/theme' },
      { text: 'Engines and the protocol', link: '/engines' },
      { text: 'Contributing', link: '/contributing' },
    ],
  },
});
