/**
 * Writes THIRD_PARTY_NOTICES.md: every production dependency with its licence, and each one's own licence text
 * (the bundled fonts' SIL OFL among them), as shipped builds must carry them.
 * Usage: pnpm notices   (or `tsx scripts/third-party-notices.ts --check` to fail when the file is out of date)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { iconAuthors } from '../apps/web/src/theme/iconSources.js';

interface Entry {
  name: string;
  versions: string[];
  paths: string[];
  license: string;
  homepage?: string;
}

const OUT = new URL('../THIRD_PARTY_NOTICES.md', import.meta.url);
const OWN = /^@crystal-bridge\//;
/** Prebuilt binaries for one platform (e.g. node-pty-darwin-arm64): left out so the file is the same on every OS. */
const PLATFORM = /-(darwin|linux|win32|freebsd|android)(-|$)/;

/**
 * Packages offered under a choice of licences (an SPDX `OR` expression), and the one Crystal Bridge uses each under. A
 * new one fails the run until its choice is added here.
 */
const CHOSEN: Readonly<Record<string, string>> = {
  dompurify: 'Apache-2.0',
  elkjs: 'EPL-2.0',
};
/** Licences whose terms ask that the notices say where the package's source is: its repository, from package.json. */
const SOURCE_NAMED = new Set(['EPL-2.0']);
/**
 * A licence file's first line, for a package whose package.json names none (khroma ships an MIT licence file but no
 * `license` field).
 */
const LICENCE_HEADINGS: readonly (readonly [RegExp, string])[] = [[/^(the )?mit license\b/i, 'MIT']];

function packageJson(paths: string[]): Record<string, unknown> | undefined {
  const file = paths.map((dir) => join(dir, 'package.json')).find((path) => existsSync(path));
  return file ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : undefined;
}

/** The package's repository as a web address, from package.json's `repository` (an object, a URL or a shorthand). */
function repositoryOf(paths: string[]): string | undefined {
  const field = packageJson(paths)?.repository;
  const raw = typeof field === 'string' ? field : (field as { url?: unknown } | undefined)?.url;
  if (typeof raw !== 'string') return undefined;
  const shorthand = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(raw);
  if (shorthand) return `https://github.com/${shorthand[1]}`;
  return raw
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '');
}

/** The licence a package is listed under: its own field, else what its licence file's first line names. */
function licenceOf(entry: Entry): string {
  if (entry.license !== 'Unknown') return entry.license;
  const firstLine =
    entry.paths
      .map(licenceText)
      .find((text) => text !== undefined)
      ?.split('\n', 1)[0] ?? '';
  return LICENCE_HEADINGS.find(([heading]) => heading.test(firstLine))?.[1] ?? entry.license;
}

/** The licence Crystal Bridge uses a package under, and the line the notices list it with. */
function described(entry: Entry): { used: string; line: string } {
  const licence = licenceOf(entry);
  const head = `- ${entry.name} ${entry.versions.join(', ')}: ${licence}`;
  if (!/\sOR\s/.test(licence)) return { used: licence, line: head };
  const used = CHOSEN[entry.name];
  if (!used) {
    throw new Error(
      `${entry.name} is offered under ${licence}: add the one Crystal Bridge uses to CHOSEN in scripts/third-party-notices.ts`,
    );
  }
  const source = SOURCE_NAMED.has(used) ? repositoryOf(entry.paths) : undefined;
  if (SOURCE_NAMED.has(used) && !source) throw new Error(`${entry.name}: no repository in its package.json`);
  return { used, line: `${head}, used under ${used}${source ? `; source: ${source}` : ''}` };
}

function licenceText(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
  return file ? readFileSync(join(dir, file), 'utf8').trim() : undefined;
}

export function render(report: Record<string, Entry[]>): string {
  const entries = Object.values(report)
    .flat()
    .filter((e) => !OWN.test(e.name) && !PLATFORM.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const listed = entries.map(described);
  const counts = new Map<string, number>();
  for (const { used } of listed) counts.set(used, (counts.get(used) ?? 0) + 1);

  const lines = [
    '# Third-party notices',
    '',
    'Crystal Bridge is MIT-licensed (`LICENSE`). It ships with the open-source packages below; each keeps its own',
    'licence, reproduced here. The Hero art has its own licences and credits in `apps/web/public/heroes`.',
    '',
    'The icons are copied from two packs into `apps/web/src/theme/iconData.ts` (`apps/web/src/theme/iconSources.ts`',
    'names each one): Game-icons (https://game-icons.net, CC BY 3.0, https://creativecommons.org/licenses/by/3.0/),',
    `by ${iconAuthors('game-icons').join(', ')}, and Phosphor Icons (https://phosphoricons.com, MIT, Copyright (c)`,
    '2023 Phosphor Icons). The app credits them on its Credits page.',
    '',
    'Generated by `scripts/third-party-notices.ts` from `pnpm licenses list --prod`; regenerate with `pnpm notices`.',
    "Prebuilt binary packages for a single platform are installed per machine and carry their parent package's licence.",
    'A package offered under a choice of licences is listed with the one Crystal Bridge uses it under, and is counted',
    'under that one below; for one used under EPL-2.0, the list says where its source is.',
    '',
    '| Licence | Packages |',
    '| --- | --- |',
    ...[...counts].sort((a, b) => b[1] - a[1]).map(([licence, n]) => `| ${licence} | ${n} |`),
    '',
    '## Packages',
    '',
    ...listed.map(({ line }) => line),
    '',
    '## Licence texts',
  ];
  for (const e of entries) {
    const text = e.paths.map(licenceText).find((t) => t !== undefined);
    lines.push(
      '',
      `### ${e.name}`,
      '',
      text ? ['```text', text, '```'].join('\n') : `${licenceOf(e)} (no licence file shipped)`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function main(): void {
  const json = execFileSync('pnpm', ['-r', 'licenses', 'list', '--prod', '--json'], { encoding: 'utf8' });
  const notices = render(JSON.parse(json) as Record<string, Entry[]>);
  if (process.argv.includes('--check')) {
    const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (current !== notices) {
      console.error('THIRD_PARTY_NOTICES.md is out of date: run `pnpm notices`');
      process.exit(1);
    }
    console.log('THIRD_PARTY_NOTICES.md is up to date');
  } else {
    writeFileSync(OUT, notices);
    console.log(`wrote THIRD_PARTY_NOTICES.md (${notices.length} bytes)`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
