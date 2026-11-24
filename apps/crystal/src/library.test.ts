import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_IMAGE_BYTES, MAX_TOME_BYTES, type TomeVersion } from '@crystal-bridge/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLibrary, libraryDirFrom, type Library } from './library.js';

// Runs as `writeTome` picks its temporary name, after the name was looked at: a test can act in that gap.
const gap = vi.hoisted(() => ({ onTemp: undefined as (() => void) | undefined }));
vi.mock('node:crypto', async (original) => {
  const crypto = await original<typeof import('node:crypto')>();
  return {
    ...crypto,
    randomBytes: (size: number) => {
      gap.onTemp?.();
      return crypto.randomBytes(size);
    },
  };
});

// Windows lets only administrators and developer mode make them.
const noSymlinks = process.platform === 'win32';

const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('CRYSTAL_LIBRARY_DIR (#290)', () => {
  it('is off, the default, or the folder named, made absolute', () => {
    const home = join(tmpdir(), 'home');
    expect(libraryDirFrom({ CRYSTAL_LIBRARY_DIR: 'off' }, home)).toBeUndefined();
    expect(libraryDirFrom({}, home)).toBe(join(home, '.crystal-bridge', 'library'));
    expect(libraryDirFrom({ CRYSTAL_LIBRARY_DIR: '' }, home)).toBe(join(home, '.crystal-bridge', 'library'));
    // Relative to where Crystal starts, not to each Quest's project folder.
    expect(libraryDirFrom({ CRYSTAL_LIBRARY_DIR: 'notes' }, home)).toBe(join(process.cwd(), 'notes'));
    const absolute = join(tmpdir(), 'vault');
    expect(libraryDirFrom({ CRYSTAL_LIBRARY_DIR: absolute }, home)).toBe(absolute);
  });
});

describe("a Kingdom's Library (#290)", () => {
  let base: string;
  let dir: string;
  let library: Library | undefined;
  const logs: string[] = [];

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'crystal-library-'));
    dir = join(base, 'library');
    logs.length = 0;
  });

  afterEach(() => {
    gap.onTemp = undefined;
    library?.stop();
    library = undefined;
    if (existsSync(dir)) chmodSync(dir, 0o700);
    rmSync(base, { recursive: true, force: true });
  });

  async function open(opts: { maxListing?: number } = {}): Promise<Library> {
    mkdirSync(dir, { recursive: true });
    library = createLibrary({ dir, log: (m) => logs.push(m), ...opts });
    await library.start();
    return library;
  }

  function put(path: string, content: string | Buffer): void {
    const full = join(dir, ...path.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }

  async function versionOf(lib: Library, path: string): Promise<TomeVersion> {
    const read = await lib.read(path);
    if (!read.ok) throw new Error(read.reason);
    return read.tome.version;
  }

  it('makes the default folder on start and lists it empty', async () => {
    library = createLibrary({ dir, log: (m) => logs.push(m) });
    expect(library.dir).toBe(dir);
    await library.start();
    expect(statSync(dir).isDirectory()).toBe(true);
    if (process.platform !== 'win32') expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(await library.list()).toEqual({ ok: true, entries: [] });
  });

  it('lists folders, Tomes and images, without what it leaves out', async () => {
    put('ops/summons.md', '# Summons\n');
    put('ops/chart.html', '<p>hi</p>');
    put('ops/map.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    put('readme.md', '# Read me\n');
    put('x.txt', 'not a Tome');
    put('.git/config', '[core]');
    put('.obsidian/app.md', '{}');
    put('node_modules/a/b.md', '# b');
    put('drafts/wip.md', '# wip');
    put('secret.md', '# secret');
    put('.gitignore', 'drafts/\nsecret.md\n');
    const lib = await open();
    const answer = await lib.list();
    if (!answer.ok) throw new Error(answer.reason);
    expect(answer.truncated).toBeUndefined();
    expect(answer.entries.map((e) => [e.path, e.kind])).toEqual([
      ['ops', 'folder'],
      ['ops/chart.html', 'html'],
      ['ops/map.png', 'image'],
      ['ops/summons.md', 'md'],
      ['readme.md', 'md'],
    ]);
    const summons = answer.entries.find((e) => e.path === 'ops/summons.md')!;
    expect(summons.size).toBe(Buffer.byteLength('# Summons\n'));
    expect(summons.mtimeMs).toBeCloseTo(statSync(join(dir, 'ops', 'summons.md')).mtimeMs, 0);
    expect(answer.entries.find((e) => e.path === 'ops')!.size).toBeUndefined();
  });

  it.skipIf(noSymlinks)('lists a symlink that stays inside, but not one that leads out or loops', async () => {
    put('real/a.md', '# a');
    put('outside.md', '# out');
    const lib = await open();
    symlinkSync(join(dir, 'real'), join(dir, 'alias'));
    symlinkSync(join(dir, 'real', 'a.md'), join(dir, 'b.md'));
    symlinkSync(join(dir, 'real'), join(dir, 'real', 'loop'));
    mkdirSync(join(base, 'away'));
    writeFileSync(join(base, 'away', 'c.md'), '# c');
    symlinkSync(join(base, 'away'), join(dir, 'away'));
    symlinkSync(join(base, 'away', 'c.md'), join(dir, 'c.md'));
    const answer = await lib.list();
    if (!answer.ok) throw new Error(answer.reason);
    const paths = answer.entries.map((e) => e.path);
    expect(paths).toContain('alias/a.md');
    expect(paths).toContain('b.md');
    // A folder that leads back up the tree isn't listed at all.
    expect(paths.some((p) => p.startsWith('real/loop'))).toBe(false);
    expect(paths.some((p) => p.startsWith('away'))).toBe(false);
    expect(paths).not.toContain('c.md');
  });

  it.runIf(process.platform !== 'win32')(
    "leaves out a name with a backslash, which isn't a separator here",
    async () => {
      put('a.md', '#');
      put('notes/a\\b.md', '#');
      put('odd\\dir/c.md', '#');
      const lib = await open();
      const answer = await lib.list();
      if (!answer.ok) throw new Error(answer.reason);
      expect(answer.entries.map((e) => e.path)).toEqual(['a.md', 'notes']);
    },
  );

  it('leaves out a path longer than the protocol carries', async () => {
    // Six folders of 200 characters: the sixth's path, and what is in it, are past the 1,024 a path may have.
    const long = ['a', 'b', 'c', 'd', 'e', 'f'].map((letter) => letter.repeat(200));
    put([...long, 'x.md'].join('/'), '#');
    put([...long.slice(0, 5), 'y'.repeat(30) + '.md'].join('/'), '#');
    put([...long.slice(0, 5), 'z.md'].join('/'), '#');
    const lib = await open();
    const answer = await lib.list();
    if (!answer.ok) throw new Error(answer.reason);
    expect(answer.entries.map((e) => e.path)).toEqual([
      ...[1, 2, 3, 4, 5].map((depth) => long.slice(0, depth).join('/')),
      [...long.slice(0, 5), 'z.md'].join('/'),
    ]);
    expect(answer.entries.every((e) => e.path.length <= 1024)).toBe(true);
  });

  it('keeps the reason short when the folder has a long path', async () => {
    dir = join(base, 'x'.repeat(200), 'y'.repeat(200), 'library');
    const lib = await open();
    rmSync(dir, { recursive: true, force: true });
    const answer = await lib.list();
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.reason.length).toBeLessThan(300);
    expect(answer.reason).toMatch(/^the Library folder is gone: …/);
    // The end of the path is kept: it is the part that tells one folder from another.
    expect(answer.reason.endsWith(join('y'.repeat(20), 'library'))).toBe(true);
  });

  it('stops at 10,000 entries and says so', async () => {
    for (const name of ['a', 'b', 'c', 'd', 'e']) put(`${name}.md`, '#');
    const lib = await open({ maxListing: 3 });
    const answer = await lib.list();
    if (!answer.ok) throw new Error(answer.reason);
    expect(answer.entries).toHaveLength(3);
    expect(answer.truncated).toBe(true);
  });

  it('reads a Tome with its version', async () => {
    const text = '# Summons\n\nCafé ☕\n';
    put('ops/summons.md', text);
    const lib = await open();
    const answer = await lib.read('ops/summons.md');
    if (!answer.ok) throw new Error(answer.reason);
    expect(answer.tome).toMatchObject({
      path: 'ops/summons.md',
      kind: 'md',
      content: text,
      encoding: 'utf8',
      truncated: false,
    });
    expect(answer.tome.link).toBeUndefined();
    expect(answer.tome.version.hash).toBe(sha256(Buffer.from(text, 'utf8')));
    expect(answer.tome.version.size).toBe(Buffer.byteLength(text));
    expect(await lib.read('ops/missing.md')).toEqual({ ok: false, reason: 'not in the Library' });
    expect(await lib.read('../outside.md')).toEqual({ ok: false, reason: 'not in the Library' });
  });

  it('cuts a Tome over 512 KB', async () => {
    // A three-byte character straddles the cut.
    const text = 'a'.repeat(MAX_TOME_BYTES - 1) + '€' + 'tail';
    put('big.md', text);
    const lib = await open();
    const answer = await lib.read('big.md');
    if (!answer.ok) throw new Error(answer.reason);
    expect(answer.tome.truncated).toBe(true);
    const bytes = Buffer.from(answer.tome.content, 'utf8');
    expect(bytes.length).toBeLessThanOrEqual(MAX_TOME_BYTES);
    expect(answer.tome.content).not.toContain('�');
    expect(answer.tome.content).toBe('a'.repeat(MAX_TOME_BYTES - 1));
    // The version is the whole file's, not the cut's.
    expect(answer.tome.version.hash).toBe(sha256(Buffer.from(text, 'utf8')));
    expect(answer.tome.version.size).toBe(Buffer.byteLength(text));
  });

  it('refuses to save over a Tome too large to have been sent whole', async () => {
    const text = 'a'.repeat(600 * 1024);
    put('big.md', text);
    const lib = await open();
    const version = await versionOf(lib, 'big.md');
    expect(await lib.write('big.md', 'hello', version)).toEqual({ ok: false, reason: 'too large to edit here' });
    expect(readFileSync(join(dir, 'big.md'), 'utf8')).toBe(text);
  });

  it("refuses a file that isn't UTF-8 text, and an image over 5 MB", async () => {
    put('latin.md', Buffer.from([0x63, 0x61, 0x66, 0xe9])); // "café" in Latin-1
    put('zero.md', Buffer.from('a\0b'));
    put('huge.png', Buffer.alloc(MAX_IMAGE_BYTES + 1));
    const lib = await open();
    expect(await lib.read('latin.md')).toEqual({ ok: false, reason: 'not text' });
    expect(await lib.read('zero.md')).toEqual({ ok: false, reason: 'not text' });
    expect(await lib.read('huge.png', 'image')).toEqual({ ok: false, reason: 'too large' });
  });

  it('reads an image as base64', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    put('img/map.png', png);
    put('a.md', '# a');
    const lib = await open();
    const answer = await lib.read('img/map.png', 'image');
    if (!answer.ok) throw new Error(answer.reason);
    expect(answer.tome).toMatchObject({ kind: 'image', encoding: 'base64', truncated: false });
    expect(Buffer.from(answer.tome.content, 'base64')).toEqual(png);
    expect(answer.tome.version.hash).toBe(sha256(png));
    expect(await lib.read('a.md', 'image')).toEqual({ ok: false, reason: 'not an image' });
  });

  it('writes with the version it was edited from', async () => {
    put('ops/summons.md', '# one\n');
    const lib = await open();
    const first = await versionOf(lib, 'ops/summons.md');

    const saved = await lib.write('ops/summons.md', '# two\n', first);
    if (!saved.ok) throw new Error(saved.reason);
    expect(saved.version.hash).toBe(sha256('# two\n'));
    expect(saved.version.size).toBe(6);
    expect(readFileSync(join(dir, 'ops', 'summons.md'), 'utf8')).toBe('# two\n');

    expect(await lib.write('ops/summons.md', '# three\n', first)).toEqual({
      ok: false,
      reason: 'changed',
      version: saved.version,
    });
    expect(readFileSync(join(dir, 'ops', 'summons.md'), 'utf8')).toBe('# two\n');

    expect(await lib.write('ops/summons.md', '# new\n', null)).toMatchObject({ ok: false, reason: 'exists' });

    const made = await lib.write('ops/fresh.md', '# fresh\n', null);
    expect(made).toMatchObject({ ok: true, version: { hash: sha256('# fresh\n') } });
    expect(readFileSync(join(dir, 'ops', 'fresh.md'), 'utf8')).toBe('# fresh\n');

    const deep = await lib.write('guides/setup/first.md', '# first\n', null);
    expect(deep.ok).toBe(true);
    expect(readFileSync(join(dir, 'guides', 'setup', 'first.md'), 'utf8')).toBe('# first\n');

    // A deleted Tome with a base is gone, not quietly made again.
    rmSync(join(dir, 'ops', 'fresh.md'));
    expect(await lib.write('ops/fresh.md', '# again\n', first)).toEqual({ ok: false, reason: 'gone' });

    // Never a folder the filter leaves out, nor a file of another kind.
    expect(await lib.write('.obsidian/x.md', '#', null)).toEqual({ ok: false, reason: 'not in the Library' });
    expect(await lib.write('notes/x.html', '#', null)).toEqual({ ok: false, reason: 'not in the Library' });
    expect(existsSync(join(dir, 'notes'))).toBe(false);
  });

  it('makes a new Tome only if nothing appears at its name first', async () => {
    const lib = await open();
    gap.onTemp = () => put('race.md', 'theirs');
    expect(await lib.write('race.md', 'mine', null)).toEqual({ ok: false, reason: 'exists' });
    expect(readFileSync(join(dir, 'race.md'), 'utf8')).toBe('theirs');
  });

  it.skipIf(noSymlinks)("doesn't make a folder through a symlink that leads out", async () => {
    mkdirSync(join(base, 'away'));
    const lib = await open();
    symlinkSync(join(base, 'away'), join(dir, 'away'));
    expect(await lib.write('away/new/x.md', '# x', null)).toEqual({ ok: false, reason: 'not in the Library' });
    expect(existsSync(join(base, 'away', 'new'))).toBe(false);
  });

  it('refuses to make CLAUDE.md or AGENTS.md', async () => {
    put('project/AGENTS.md', '# old\n');
    const lib = await open();
    for (const path of ['CLAUDE.md', 'claude.md', 'Agents.MD', 'project/sub/AGENTS.md', 'project/claude.MD']) {
      const answer = await lib.write(path, '# hi', null);
      expect(answer.ok).toBe(false);
      if (!answer.ok) expect(answer.reason).toMatch(/instructions/);
    }
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false);
    const version = await versionOf(lib, 'project/AGENTS.md');
    expect((await lib.write('project/AGENTS.md', '# new\n', version)).ok).toBe(true);
    expect(readFileSync(join(dir, 'project', 'AGENTS.md'), 'utf8')).toBe('# new\n');
  });

  it.skipIf(noSymlinks)('flags a Tome that is a symlink, and refuses to save it plainly', async () => {
    put('real.md', '# real\n');
    const lib = await open();
    symlinkSync(join(dir, 'real.md'), join(dir, 'alias.md'));
    const answer = await lib.read('alias.md');
    if (!answer.ok) throw new Error(answer.reason);
    expect(answer.tome).toMatchObject({ path: 'alias.md', content: '# real\n', link: true });
    expect(await lib.write('alias.md', '# changed\n', answer.tome.version)).toEqual({ ok: false, reason: 'a link' });
    expect(await lib.write('alias.md', '# changed\n', null)).toEqual({ ok: false, reason: 'a link' });
    expect(readFileSync(join(dir, 'real.md'), 'utf8')).toBe('# real\n');

    // One that leads out stays out of sight.
    writeFileSync(join(base, 'away.md'), '# away');
    symlinkSync(join(base, 'away.md'), join(dir, 'away.md'));
    expect(await lib.read('away.md')).toEqual({ ok: false, reason: 'not in the Library' });
    expect(await lib.write('away.md', '#', null)).toEqual({ ok: false, reason: 'not in the Library' });
  });

  it('an unreadable folder says why', async () => {
    const lib = await open();
    rmSync(dir, { recursive: true, force: true });
    expect(await lib.list()).toEqual({ ok: false, reason: `the Library folder is gone: ${dir}` });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    "an unreadable folder says it can't be read",
    async () => {
      const lib = await open();
      chmodSync(dir, 0o000);
      const answer = await lib.list();
      expect(answer.ok).toBe(false);
      if (!answer.ok) expect(answer.reason).toBe(`the Library folder can't be read: ${dir}`);
    },
  );

  it('reloads the filter when the .gitignore changes', async () => {
    put('a.md', '# a');
    put('b.md', '# b');
    const lib = await open();
    expect((await lib.read('b.md')).ok).toBe(true);
    writeFileSync(join(dir, '.gitignore'), 'b.md\n');
    await expect.poll(async () => (await lib.read('b.md')).ok, { timeout: 5000 }).toBe(false);
    const answer = await lib.list();
    if (!answer.ok) throw new Error(answer.reason);
    expect(answer.entries.map((e) => e.path)).toEqual(['a.md']);
  });

  it('passes on what the watcher sees', async () => {
    const changes: unknown[] = [];
    mkdirSync(dir, { recursive: true });
    library = createLibrary({ dir, log: () => {}, onChange: (c) => changes.push(c) });
    await library.start();
    put('new.md', '# new');
    await expect.poll(() => changes.length, { timeout: 5000 }).toBeGreaterThan(0);
    expect(changes).toContainEqual({ paths: ['new.md'] });
  });
});
