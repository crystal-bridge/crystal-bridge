import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { descriptionReporter, frontmatter, readDescriptions } from './descriptions.js';

let root: string;
let config: string;
let project: string;
let plugin: string;

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
const doc = (description: string, extra = '') => `---\n${extra}description: ${description}\n---\n\n# Body\n`;
const read = (plugins: { name: string; path: string }[] = []) =>
  readDescriptions({ configDir: config, cwd: project, plugins });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cb-descriptions-'));
  config = join(root, 'config');
  project = join(root, 'project');
  plugin = join(root, 'plugin');
  mkdirSync(config);
  mkdirSync(project);
  mkdirSync(plugin);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('frontmatter', () => {
  it('reads a plain line, quotes and a colon in the text', () => {
    expect(frontmatter(doc('Ship it: fast')).description).toBe('Ship it: fast');
    expect(frontmatter(doc('"Say \\"hi\\" now"')).description).toBe('Say "hi" now');
    expect(frontmatter(doc("'It''s here'")).description).toBe("It's here");
  });

  it('reads a block and a wrapped line as one line', () => {
    expect(frontmatter('---\ndescription: >-\n  Two\n  lines\nname: x\n---\n').description).toBe('Two lines');
    expect(frontmatter('---\ndescription: |\n  Two\n\n  lines\n---\n').description).toBe('Two lines');
    expect(frontmatter('---\ndescription: Two\n  lines\n---\n').description).toBe('Two lines');
  });

  it('reads a name, and Windows line ends', () => {
    expect(frontmatter('---\r\nname: real\r\ndescription: Text\r\n---\r\n')).toEqual({
      name: 'real',
      description: 'Text',
    });
  });

  it('finds nothing without frontmatter, or past its end', () => {
    expect(frontmatter('# Just a heading\n\ndescription: not this')).toEqual({});
    expect(frontmatter('---\nname: x\n---\ndescription: not this')).toEqual({ name: 'x' });
  });
});

describe('readDescriptions', () => {
  it('reads personal and project skills, commands and agents', async () => {
    write(join(config, 'skills/mine/SKILL.md'), doc('My skill'));
    write(join(project, '.claude/skills/ours/SKILL.md'), doc('Our skill'));
    write(join(config, 'commands/deploy.md'), doc('Deploys'));
    write(join(project, '.claude/agents/checker.md'), doc('Checks', 'name: code-checker\n'));
    expect(await read()).toEqual({
      mine: 'My skill',
      ours: 'Our skill',
      deploy: 'Deploys',
      'code-checker': 'Checks',
    });
  });

  it('names a plugin-s as plugin:name', async () => {
    write(join(plugin, 'skills/plug/SKILL.md'), doc('Plugin skill'));
    write(join(plugin, 'commands/go.md'), doc('Plugin command'));
    write(join(plugin, 'agents/helper.md'), doc('Plugin agent'));
    expect(await read([{ name: 'demo', path: plugin }])).toEqual({
      'demo:plug': 'Plugin skill',
      'demo:go': 'Plugin command',
      'demo:helper': 'Plugin agent',
    });
  });

  it('reads skills synced from the account', async () => {
    write(join(config, 'skills/synced/account-id/from-account/SKILL.md'), doc('Synced skill'));
    write(join(config, 'skills/synced/account-id/manifest.json'), '{}');
    expect(await read()).toEqual({ '*:from-account': 'Synced skill' });
  });

  it('prefers the project-s when both have the name', async () => {
    write(join(config, 'skills/same/SKILL.md'), doc('Personal'));
    write(join(project, '.claude/skills/same/SKILL.md'), doc('Project'));
    expect(await read()).toEqual({ same: 'Project' });
  });

  it('skips files with no description, and missing folders', async () => {
    write(join(config, 'skills/bare/SKILL.md'), '# No frontmatter\n');
    write(join(config, 'skills/empty/SKILL.md'), '---\nname: empty\n---\n');
    expect(await read([{ name: 'gone', path: join(root, 'nowhere') }])).toEqual({});
  });

  it('caps a description', async () => {
    write(join(config, 'skills/long/SKILL.md'), doc('x'.repeat(1000)));
    const { long } = await read();
    expect(long).toHaveLength(300);
    expect(long!.endsWith('…')).toBe(true);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('skips an unreadable file', async () => {
    write(join(config, 'skills/locked/SKILL.md'), doc('Secret'));
    write(join(config, 'skills/open/SKILL.md'), doc('Fine'));
    chmodSync(join(config, 'skills/locked/SKILL.md'), 0);
    expect(await read()).toEqual({ open: 'Fine' });
  });

  it.skipIf(process.platform === 'win32')('skips a symlink out of its folder, and keeps one inside', async () => {
    write(join(root, 'outside/SKILL.md'), doc('Outside'));
    write(join(config, 'skills/real/SKILL.md'), doc('Inside'));
    symlinkSync(join(root, 'outside'), join(config, 'skills/escape'));
    symlinkSync(join(config, 'skills/real'), join(config, 'skills/alias'));
    expect(await read()).toEqual({ real: 'Inside', alias: 'Inside' });
  });

  it.skipIf(process.platform === 'win32')('follows a skills folder that is itself a link', async () => {
    write(join(root, 'dotfiles/skills/kept/SKILL.md'), doc('Kept in dotfiles'));
    symlinkSync(join(root, 'dotfiles/skills'), join(config, 'skills'));
    expect(await read()).toEqual({ kept: 'Kept in dotfiles' });
  });

  it('stops at the scan limit, the project-s first', async () => {
    write(join(project, '.claude/commands/ours.md'), doc('Ours'));
    for (const i of [1, 2, 3, 4, 5]) write(join(config, `commands/c${i}.md`), doc(`Command ${i}`));
    const found = await readDescriptions({ configDir: config, cwd: project, plugins: [] }, 3);
    expect(Object.keys(found)).toHaveLength(3);
    expect(found.ours).toBe('Ours');
  });
});

describe('descriptionReporter', () => {
  const init = (skills: string[], plugins: unknown[] = [], agents: string[] = []) => ({
    type: 'system',
    subtype: 'init',
    skills,
    slash_commands: skills,
    agents,
    plugins,
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
  const reporter = () => descriptionReporter({ configDir: config, cwd: project });

  it('sends only what this Quest lists, as a line of its own', async () => {
    write(join(config, 'skills/listed/SKILL.md'), doc('Listed'));
    write(join(config, 'skills/other/SKILL.md'), doc('Not listed'));
    const emit = vi.fn();
    reporter()(init(['listed']), emit);
    await vi.waitFor(() => expect(emit).toHaveBeenCalled());
    expect(emit).toHaveBeenCalledExactlyOnceWith({
      engine: 'claude',
      raw: { type: 'system', subtype: 'descriptions', descriptions: { listed: 'Listed' } },
    });
  });

  it('reads a list once, however many turns repeat it, and again when it changes', async () => {
    write(join(config, 'skills/one/SKILL.md'), doc('One'));
    write(join(config, 'skills/two/SKILL.md'), doc('Two'));
    const emit = vi.fn();
    const report = reporter();
    report(init(['one']), emit);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1));
    report(init(['one']), emit);
    await flush();
    expect(emit).toHaveBeenCalledTimes(1);
    report(init(['one', 'two']), emit);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(2));
    expect(emit.mock.lastCall![0].raw.descriptions).toEqual({ one: 'One', two: 'Two' });
  });

  it('uses plugin paths from the init, skipping built-ins and paths that aren-t text', async () => {
    write(join(plugin, 'agents/helper.md'), doc('Plugin agent'));
    const emit = vi.fn();
    const plugins = [
      { name: 'demo', path: plugin },
      { name: 'core', path: 'builtin' },
      { name: 'odd', path: 7 },
    ];
    reporter()(init([], plugins, ['demo:helper']), emit);
    await vi.waitFor(() => expect(emit).toHaveBeenCalled());
    expect(emit.mock.calls[0]![0].raw.descriptions).toEqual({ 'demo:helper': 'Plugin agent' });
  });

  it('matches a synced skill by the part after the colon, and never a bare name', async () => {
    write(join(config, 'skills/synced/account-id/from-account/SKILL.md'), doc('Synced skill'));
    write(join(project, '.claude/skills/own/SKILL.md'), doc('Own skill'));
    const emit = vi.fn();
    reporter()(init(['some-source:from-account', 'from-account', 'own']), emit);
    await vi.waitFor(() => expect(emit).toHaveBeenCalled());
    expect(emit.mock.calls[0]![0].raw.descriptions).toEqual({
      'some-source:from-account': 'Synced skill',
      own: 'Own skill',
    });
  });

  it('stays quiet when nothing has a description', async () => {
    const emit = vi.fn();
    reporter()(init(['plain']), emit);
    await flush();
    expect(emit).not.toHaveBeenCalled();
  });
});
