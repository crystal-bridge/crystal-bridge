import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkLibraryPath, libraryFilter, resolveForRead, writeTome } from './libraryPaths.js';

// The temporary file's name comes from randomBytes; a test can pin it to plant a symlink at exactly that name.
// `onTemp` runs as the temporary name is picked, after the target was looked at: a test can act in that gap.
const pinned = vi.hoisted(() => ({
  bytes: undefined as Buffer | undefined,
  onTemp: undefined as (() => void) | undefined,
  // A real path to answer for a given path, as a Windows short (8.3) name would resolve to its long one.
  realpath: new Map<string, string>(),
  linkError: undefined as string | undefined,
}));
vi.mock('node:crypto', async (original) => {
  const crypto = await original<typeof import('node:crypto')>();
  return {
    ...crypto,
    randomBytes: (size: number) => {
      pinned.onTemp?.();
      return pinned.bytes ?? crypto.randomBytes(size);
    },
  };
});
vi.mock('node:fs/promises', async (original) => {
  const fsp = await original<typeof import('node:fs/promises')>();
  return {
    ...fsp,
    realpath: async (path: string) => pinned.realpath.get(path) ?? fsp.realpath(path),
    link: async (from: string, to: string) => {
      if (pinned.linkError) throw Object.assign(new Error(pinned.linkError), { code: pinned.linkError });
      return fsp.link(from, to);
    },
  };
});

// Windows lets only administrators and developer mode make them.
const noSymlinks = process.platform === 'win32';

// macOS's and Windows' default file systems; Linux's aren't.
const caseInsensitive = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'crystal-case-'));
  writeFileSync(join(probe, 'a'), '');
  const result = existsSync(join(probe, 'A'));
  rmSync(probe, { recursive: true, force: true });
  return result;
})();

const REFUSED = { ok: false, reason: 'not in the Library' };

describe('Library paths (#290)', () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'crystal-library-'));
    root = join(base, 'library');
    outside = join(base, 'outside');
    mkdirSync(join(root, 'ops'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(root, 'ops', 'summons.md'), '# Summons\n');
    writeFileSync(join(outside, 'secret.md'), 'not yours');
  });
  afterEach(() => {
    pinned.bytes = undefined;
    pinned.onTemp = undefined;
    pinned.realpath.clear();
    pinned.linkError = undefined;
    rmSync(base, { recursive: true, force: true });
  });

  describe('checkLibraryPath', () => {
    it('refuses anything that could leave the Library or reach a hidden, ignored or network path', () => {
      for (const path of [
        '/etc/passwd',
        '../x.md',
        'a/../../x.md',
        'C:\\x.md',
        'C:x.md',
        '\\\\server\\share\\x.md',
        '//server/share/x.md',
        'a:b.md',
        '.git/config',
        '.GIT/hooks/pre-commit',
        'notes/.obsidian/app.json',
        '.env',
        'node_modules/x/readme.md',
        'a\0b.md',
        '',
        './x.md',
        'a//b.md',
        'a/',
        'a\\..\\..\\x.md',
      ]) {
        expect(checkLibraryPath(path), JSON.stringify(path)).toEqual(REFUSED);
      }
    });

    it('accepts Markdown, HTML and images by a lower-cased extension, and says which', () => {
      expect(checkLibraryPath('ops/Summons.md')).toEqual({ ok: true, parts: ['ops', 'Summons.md'], kind: 'md' });
      expect(checkLibraryPath('a b/c.md')).toEqual({ ok: true, parts: ['a b', 'c.md'], kind: 'md' });
      expect(checkLibraryPath('img/flow.PNG')).toEqual({ ok: true, parts: ['img', 'flow.PNG'], kind: 'image' });
      expect(checkLibraryPath('pages/report.htm')).toMatchObject({ ok: true, kind: 'html' });
      expect(checkLibraryPath('ops\\summons.md')).toEqual({ ok: true, parts: ['ops', 'summons.md'], kind: 'md' });
    });

    it('refuses a Windows device name and a name Windows would trim, in any folder', () => {
      for (const path of [
        'CON.md',
        'nul.md',
        'aux/x.md',
        'com1.md',
        'COM¹.md',
        'lpt9.md',
        'node_modules./x/readme.md',
        '.git./config.md',
        'ops /x.md',
        'notes./x.md',
      ]) {
        expect(checkLibraryPath(path), JSON.stringify(path)).toEqual(REFUSED);
      }
      expect(checkLibraryPath('console.md')).toMatchObject({ ok: true, kind: 'md' });
      expect(checkLibraryPath('conference/x.md')).toMatchObject({ ok: true, kind: 'md' });
    });

    it('refuses other extensions with the same reason', () => {
      for (const path of ['x.txt', 'x.exe', 'x', 'x.md.']) expect(checkLibraryPath(path), path).toEqual(REFUSED);
    });

    it('writes only Markdown', () => {
      expect(checkLibraryPath('ops/new.md', { write: true })).toMatchObject({ ok: true, kind: 'md' });
      for (const path of ['img/flow.png', 'pages/report.html', 'x.txt', 'x.svg']) {
        expect(checkLibraryPath(path, { write: true }), path).toEqual(REFUSED);
      }
    });
  });

  describe('resolveForRead', () => {
    it('reads a Tome by its path in the Library, and reports the real one', async () => {
      const allowed = libraryFilter(root);
      expect(await resolveForRead(root, 'ops/summons.md', allowed)).toMatchObject({
        ok: true,
        relative: 'ops/summons.md',
        kind: 'md',
      });
    });

    it('refuses folders and missing files as it refuses anything else', async () => {
      mkdirSync(join(root, 'folder.md'));
      const allowed = libraryFilter(root);
      expect(await resolveForRead(root, 'folder.md', allowed)).toEqual(REFUSED);
      expect(await resolveForRead(root, 'ops/missing.md', allowed)).toEqual(REFUSED);
    });

    it.skipIf(noSymlinks)('refuses a symlink that leads out, to a file or to a folder', async () => {
      symlinkSync(join(outside, 'secret.md'), join(root, 'escape.md'));
      symlinkSync(outside, join(root, 'escape-dir'));
      const allowed = libraryFilter(root);
      for (const path of ['escape.md', 'escape-dir/secret.md']) {
        expect(await resolveForRead(root, path, allowed), path).toEqual(REFUSED);
      }
    });

    it.skipIf(noSymlinks)('follows a symlinked folder that stays inside', async () => {
      symlinkSync(join(root, 'ops'), join(root, 'alias'));
      expect(await resolveForRead(root, 'alias/summons.md', libraryFilter(root))).toMatchObject({
        ok: true,
        relative: 'ops/summons.md',
      });
    });

    it.skipIf(noSymlinks)('refuses a symlink whose real file is hidden, ignored or of another kind', async () => {
      mkdirSync(join(root, '.git'));
      writeFileSync(join(root, '.git', 'config.md'), 'x');
      writeFileSync(join(root, 'notes.txt'), 'x');
      writeFileSync(join(root, '.gitignore'), 'drafts/\n');
      mkdirSync(join(root, 'drafts'));
      writeFileSync(join(root, 'drafts', 'x.md'), 'x');
      symlinkSync(join(root, '.git', 'config.md'), join(root, 'config.md'));
      symlinkSync(join(root, 'notes.txt'), join(root, 'notes.md'));
      symlinkSync(join(root, 'drafts', 'x.md'), join(root, 'public.md'));
      const allowed = libraryFilter(root);
      for (const path of ['config.md', 'notes.md', 'public.md']) {
        expect(await resolveForRead(root, path, allowed), path).toEqual(REFUSED);
      }
    });

    it('refuses a path the top-level .gitignore excludes', async () => {
      writeFileSync(join(root, '.gitignore'), 'drafts/\n*.secret.md\n');
      mkdirSync(join(root, 'drafts', 'deep'), { recursive: true });
      writeFileSync(join(root, 'drafts', 'x.md'), 'x');
      writeFileSync(join(root, 'drafts', 'deep', 'y.md'), 'y');
      writeFileSync(join(root, 'ops', 'plans.secret.md'), 'x');
      const allowed = libraryFilter(root);
      for (const path of ['drafts/x.md', 'drafts/deep/y.md', 'ops/plans.secret.md']) {
        expect(await resolveForRead(root, path, allowed), path).toEqual(REFUSED);
      }
      expect(await resolveForRead(root, 'ops/summons.md', allowed)).toMatchObject({ ok: true });
    });

    it('works without a .gitignore, and still leaves out dot names and node_modules', () => {
      const allowed = libraryFilter(root);
      expect(allowed('ops/summons.md', false)).toBe(true);
      expect(allowed('ops', true)).toBe(true);
      expect(allowed('.obsidian', true)).toBe(false);
      expect(allowed('a/.Trash/x.md', false)).toBe(false);
      expect(allowed('node_modules', true)).toBe(false);
      expect(allowed('x/Node_Modules/y.md', false)).toBe(false);
    });

    it.runIf(process.platform === 'win32')('refuses a junction that leads out', async () => {
      writeFileSync(join(outside, 'x.md'), 'not yours');
      symlinkSync(outside, join(root, 'j'), 'junction');
      expect(await resolveForRead(root, 'j/x.md', libraryFilter(root))).toEqual(REFUSED);
    });

    it.runIf(caseInsensitive)('on a case-insensitive disk, reads by any case and reports the stored one', async () => {
      writeFileSync(join(root, '.gitignore'), 'drafts/\n');
      mkdirSync(join(root, 'drafts'));
      writeFileSync(join(root, 'drafts', 'x.md'), 'x');
      const allowed = libraryFilter(root);
      expect(await resolveForRead(root, 'OPS/summons.md', allowed)).toMatchObject({
        ok: true,
        relative: 'ops/summons.md',
      });
      expect(await resolveForRead(root, 'DRAFTS/x.md', allowed)).toEqual(REFUSED);
    });
  });

  describe('writeTome', () => {
    it('writes a new Tome and replaces an existing one, leaving no temporary file', async () => {
      const allowed = libraryFilter(root);
      expect(await writeTome(root, 'ops/new.md', '# New\n', allowed)).toMatchObject({ ok: true });
      expect(await writeTome(root, 'ops/summons.md', '# Changed\n', allowed)).toMatchObject({ ok: true });
      expect(readFileSync(join(root, 'ops', 'new.md'), 'utf8')).toBe('# New\n');
      expect(readFileSync(join(root, 'ops', 'summons.md'), 'utf8')).toBe('# Changed\n');
      expect(readdirSync(join(root, 'ops')).sort()).toEqual(['new.md', 'summons.md']);
    });

    it('refuses anything but Markdown, and paths the filter leaves out', async () => {
      writeFileSync(join(root, '.gitignore'), 'drafts/\n');
      mkdirSync(join(root, 'drafts'));
      const allowed = libraryFilter(root);
      for (const path of ['ops/x.html', 'ops/x.png', 'drafts/x.md', '../outside/x.md', 'missing/x.md']) {
        expect(await writeTome(root, path, 'x', allowed), path).toEqual(REFUSED);
      }
      expect(readdirSync(join(root, 'drafts'))).toEqual([]);
      expect(readdirSync(outside)).toEqual(['secret.md']);
    });

    it.skipIf(noSymlinks)('never follows a symlink planted at the temporary name', async () => {
      pinned.bytes = Buffer.from('0123456789abcdef', 'hex').subarray(0, 8);
      const temp = '.tome-' + pinned.bytes.toString('hex') + '.tmp';
      writeFileSync(join(outside, 'target.md'), 'unchanged');
      symlinkSync(join(outside, 'target.md'), join(root, 'ops', temp));
      symlinkSync(join(outside, 'dangling.md'), join(root, 'ops', '.tome-other.tmp'));

      const result = await writeTome(root, 'ops/summons.md', 'planted', libraryFilter(root));

      expect(readFileSync(join(outside, 'target.md'), 'utf8')).toBe('unchanged');
      expect(existsSync(join(outside, 'dangling.md'))).toBe(false);
      // The pinned name is taken, so the exclusive create fails and the old Tome stays; the planted link isn't ours.
      expect(result).toEqual(REFUSED);
      expect(readFileSync(join(root, 'ops', 'summons.md'), 'utf8')).toBe('# Summons\n');
      expect(lstatSync(join(root, 'ops', temp)).isSymbolicLink()).toBe(true);

      // Unpinned, the next write picks another name and goes through.
      pinned.bytes = undefined;
      expect(await writeTome(root, 'ops/summons.md', 'written', libraryFilter(root))).toMatchObject({ ok: true });
      expect(readFileSync(join(outside, 'target.md'), 'utf8')).toBe('unchanged');
    });

    it.skipIf(process.platform === 'win32')('gives the new file the old file’s permissions', async () => {
      chmodSync(join(root, 'ops', 'summons.md'), 0o640);
      expect(await writeTome(root, 'ops/summons.md', 'x', libraryFilter(root))).toMatchObject({ ok: true });
      expect(statSync(join(root, 'ops', 'summons.md')).mode & 0o777).toBe(0o640);
    });

    it.skipIf(noSymlinks)('refuses a write whose parent folder is a symlink that leads out', async () => {
      symlinkSync(outside, join(root, 'escape-dir'));
      expect(await writeTome(root, 'escape-dir/x.md', 'x', libraryFilter(root))).toEqual(REFUSED);
      expect(readdirSync(outside)).toEqual(['secret.md']);
    });

    it('refuses a write into a dot folder in any letter case', async () => {
      mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
      mkdirSync(join(root, '.obsidian'));
      const allowed = libraryFilter(root);
      for (const path of ['.git/hooks/x.md', '.GIT/hooks/x.md', '.Obsidian/x.md', 'ops/.hidden.md']) {
        expect(await writeTome(root, path, 'x', allowed), path).toEqual(REFUSED);
      }
      expect(readdirSync(join(root, '.git', 'hooks'))).toEqual([]);
      expect(readdirSync(join(root, '.obsidian'))).toEqual([]);
    });

    it.skipIf(noSymlinks)('refuses a write through a plainly named symlink to a dot folder inside', async () => {
      mkdirSync(join(root, '.git'));
      symlinkSync(join(root, '.git'), join(root, 'plain'));
      expect(await writeTome(root, 'plain/x.md', 'x', libraryFilter(root))).toEqual(REFUSED);
      expect(readdirSync(join(root, '.git'))).toEqual([]);
    });

    it.skipIf(noSymlinks)('refuses to write over a symlink, even one that stays inside', async () => {
      symlinkSync(join(outside, 'secret.md'), join(root, 'ops', 'out.md'));
      symlinkSync(join(root, 'ops', 'summons.md'), join(root, 'ops', 'in.md'));
      const allowed = libraryFilter(root);
      expect(await writeTome(root, 'ops/out.md', 'x', allowed)).toEqual(REFUSED);
      expect(await writeTome(root, 'ops/in.md', 'x', allowed)).toEqual(REFUSED);
      expect(readFileSync(join(outside, 'secret.md'), 'utf8')).toBe('not yours');
      expect(readFileSync(join(root, 'ops', 'summons.md'), 'utf8')).toBe('# Summons\n');
    });

    it('replaces a hard link with a plain file and leaves the other name alone', async () => {
      linkSync(join(root, 'ops', 'summons.md'), join(outside, 'linked.md'));
      expect(await writeTome(root, 'ops/summons.md', '# New\n', libraryFilter(root))).toMatchObject({ ok: true });
      expect(readFileSync(join(root, 'ops', 'summons.md'), 'utf8')).toBe('# New\n');
      expect(readFileSync(join(outside, 'linked.md'), 'utf8')).toBe('# Summons\n');
      expect(statSync(join(root, 'ops', 'summons.md')).nlink).toBe(1);
    });

    it('refuses a target whose real name the filter leaves out, before anything is renamed', async () => {
      // A Windows short name (`GIT~1`) is one way a plain-looking name reaches a hidden file.
      mkdirSync(join(root, '.git'));
      writeFileSync(join(root, '.git', 'config.md'), 'git');
      pinned.realpath.set(join(realpathSync(root), 'ops', 'summons.md'), join(realpathSync(root), '.git', 'config.md'));
      expect(await writeTome(root, 'ops/summons.md', 'x', libraryFilter(root))).toEqual(REFUSED);
      expect(readFileSync(join(root, 'ops', 'summons.md'), 'utf8')).toBe('# Summons\n');
      expect(readdirSync(join(root, 'ops'))).toEqual(['summons.md']);
    });

    it('never removes the file it renamed in when the check after fails', async () => {
      const target = join(root, 'ops', 'summons.md');
      // Allows the Tome until the new text is in place, as if the real path had moved out in the meantime.
      const plain = libraryFilter(root);
      const allowed = (path: string, isFolder: boolean) =>
        plain(path, isFolder) && !(path === 'ops/summons.md' && readFileSync(target, 'utf8') === '# New\n');
      expect(await writeTome(root, 'ops/summons.md', '# New\n', allowed)).toEqual(REFUSED);
      expect(existsSync(target)).toBe(true);
    });

    it('in exclusive mode, says exists when a file appears at the name before it lands', async () => {
      const allowed = libraryFilter(root);
      const target = join(root, 'ops', 'fresh.md');
      pinned.onTemp = () => writeFileSync(target, 'theirs');
      expect(await writeTome(root, 'ops/fresh.md', 'mine', allowed, { exclusive: true })).toEqual({
        ok: false,
        reason: 'exists',
      });
      expect(readFileSync(target, 'utf8')).toBe('theirs');
      expect(readdirSync(join(root, 'ops')).sort()).toEqual(['fresh.md', 'summons.md']);

      pinned.onTemp = undefined;
      expect(await writeTome(root, 'ops/summons.md', 'x', allowed, { exclusive: true })).toEqual({
        ok: false,
        reason: 'exists',
      });
      expect(await writeTome(root, 'ops/other.md', 'other', allowed, { exclusive: true })).toMatchObject({ ok: true });
      expect(readFileSync(join(root, 'ops', 'other.md'), 'utf8')).toBe('other');
      expect(readdirSync(join(root, 'ops')).sort()).toEqual(['fresh.md', 'other.md', 'summons.md']);
    });

    it('in exclusive mode, falls back to a rename where the file system has no hard links', async () => {
      pinned.linkError = 'EPERM';
      expect(await writeTome(root, 'ops/fresh.md', 'mine', libraryFilter(root), { exclusive: true })).toMatchObject({
        ok: true,
      });
      expect(readFileSync(join(root, 'ops', 'fresh.md'), 'utf8')).toBe('mine');
      expect(readdirSync(join(root, 'ops')).sort()).toEqual(['fresh.md', 'summons.md']);
    });

    it.runIf(caseInsensitive)('on a case-insensitive disk, writes the stored file by any case', async () => {
      expect(await writeTome(root, 'OPS/summons.md', '# Upper\n', libraryFilter(root))).toMatchObject({ ok: true });
      expect(readFileSync(join(root, 'ops', 'summons.md'), 'utf8')).toBe('# Upper\n');
      expect(readdirSync(join(root, 'ops'))).toHaveLength(1);
    });
  });
});
