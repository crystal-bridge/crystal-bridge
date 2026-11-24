import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, open, realpath, rename, stat, unlink } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import ignore from 'ignore';

/** The kinds of file the Library reaches; folders are listed too, but never read or written. */
export type LibraryKind = 'md' | 'html' | 'image';
export type PathCheck = { ok: true; parts: string[]; kind?: LibraryKind } | { ok: false; reason: string };
/** Whether a path relative to the Library, with `/` between its parts, is in it. */
export type Filter = (relative: string, isFolder: boolean) => boolean;

/** One answer for every refusal and for a missing file, so a refusal never says what exists. */
const NOT_HERE = 'not in the Library';
const refused = { ok: false, reason: NOT_HERE } as const;

const KINDS: Record<string, LibraryKind> = {
  md: 'md',
  html: 'html',
  htm: 'html',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  svg: 'image',
};

// Names Windows takes as devices in any folder and with any extension.
const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;

/** A Library file's kind by its lower-cased extension, or undefined for any other file. */
function kindOf(name: string): LibraryKind | undefined {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return undefined;
  return KINDS[name.slice(dot + 1).toLowerCase()];
}

/** A dot name (`.git`, `.obsidian`, `.env`) or `node_modules`, in any letter case. */
function hidden(segment: string): boolean {
  return segment.startsWith('.') || segment.toLowerCase() === 'node_modules';
}

/** `path` is the folder itself or somewhere under it: the rule from files.ts. */
function within(folder: string, path: string): boolean {
  return path === folder || path.startsWith(folder + sep);
}

/** A real path under the Library's real path, in the Library's form (`/` between parts on every system). */
function libraryRelative(rootReal: string, real: string): string {
  return relative(rootReal, real).split(sep).join('/');
}

/** Lexical checks only: run before touching the disk, so a network path never makes Windows reach out. */
export function checkLibraryPath(requested: string, { write = false } = {}): PathCheck {
  // A drive letter, a stream name (`x:y.md`) and a NUL all stop here, before the parts are looked at.
  if (requested === '' || requested.includes(':') || requested.includes('\0')) return refused;
  // A leading separator is an absolute path, or a network one (`//server/share`, `\\server\share`).
  if (requested.startsWith('/') || requested.startsWith('\\')) return refused;
  const parts = requested.split(/[/\\]/);
  for (const part of parts) {
    // `.` and `..` start with a dot too.
    if (part === '' || hidden(part)) return refused;
    // Windows drops a trailing dot or space, so `node_modules.` would be `node_modules`; and it opens a device name.
    if (part.endsWith('.') || part.endsWith(' ') || DEVICE.test(part)) return refused;
  }
  const kind = kindOf(parts[parts.length - 1]!);
  if (!kind || (write && kind !== 'md')) return refused;
  return { ok: true, parts, kind };
}

/** Loads the top-level .gitignore (absent is fine) into an `ignore` matcher; plus dot names and node_modules. */
export function libraryFilter(root: string): Filter {
  const matcher = ignore();
  try {
    matcher.add(readFileSync(join(root, '.gitignore'), 'utf8'));
  } catch {
    // No .gitignore, or one we can't read: only the built-in rules apply.
  }
  return (path, isFolder) => {
    if (path === '') return true;
    if (path.split('/').some(hidden)) return false;
    // `ignore` checks each parent folder too, so `drafts/` covers everything under it.
    return !matcher.ignores(isFolder ? path + '/' : path);
  };
}

/**
 * Resolves a requested path to a real file inside the Library: the lexical check, then the real path with symlinks
 * (and Windows junctions) followed, which must lie inside the Library's real path, pass the filter again and keep its
 * kind. The comparison is between real paths, never the asked spelling, so letter case on a case-insensitive disk
 * changes nothing.
 */
export async function resolveForRead(
  root: string,
  requested: string,
  allowed: Filter,
): Promise<{ ok: true; real: string; relative: string; kind: LibraryKind } | { ok: false; reason: string }> {
  const check = checkLibraryPath(requested);
  if (!check.ok || !allowed(check.parts.join('/'), false)) return refused;
  let rootReal: string;
  let real: string;
  try {
    rootReal = await realpath(root);
    real = await realpath(join(rootReal, ...check.parts));
  } catch {
    return refused;
  }
  if (real === rootReal || !within(rootReal, real)) return refused;
  const path = libraryRelative(rootReal, real);
  const kind = kindOf(path.slice(path.lastIndexOf('/') + 1));
  if (!kind || kind !== check.kind || !allowed(path, false)) return refused;
  try {
    if (!(await stat(real)).isFile()) return refused;
  } catch {
    return refused;
  }
  return { ok: true, real, relative: path, kind };
}

/**
 * Writes a Markdown Tome in the four steps of docs/LIBRARY.md: the lexical check; the parent folder's real path,
 * inside the Library and in it by the filter; a temporary file created exclusively (so a symlink planted at its name
 * is never followed) with the old file's permissions; and a rename into place, after which the result's real path is
 * checked again. A crash leaves the old Tome or the new one, never half of one. An existing symlink is never written
 * over, and a hard link is replaced by a plain file.
 */
export async function writeTome(
  root: string,
  requested: string,
  content: string,
  allowed: Filter,
): Promise<{ ok: true; real: string } | { ok: false; reason: string }> {
  // 1. Before touching the disk.
  const check = checkLibraryPath(requested, { write: true });
  if (!check.ok || !allowed(check.parts.join('/'), false)) return refused;
  const name = check.parts[check.parts.length - 1]!;

  // 2. The parent folder, for real.
  let rootReal: string;
  let parent: string;
  try {
    rootReal = await realpath(root);
    parent = await realpath(join(rootReal, ...check.parts.slice(0, -1)));
    if (!(await stat(parent)).isDirectory()) return refused;
  } catch {
    return refused;
  }
  if (!within(rootReal, parent) || !allowed(libraryRelative(rootReal, parent), true)) return refused;
  const target = join(parent, name);
  if (!allowed(libraryRelative(rootReal, target), false)) return refused;

  let mode = 0o644;
  try {
    const old = await lstat(target);
    if (!old.isFile()) return refused;
    mode = old.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return refused;
  }

  // 3. A fresh file at a random dot name, which the listing and the watcher skip.
  const temp = join(parent, '.tome-' + randomBytes(8).toString('hex') + '.tmp');
  let handle;
  try {
    handle = await open(temp, 'wx', mode);
  } catch {
    // The name exists (a planted symlink, say): it was never opened, and it isn't ours to remove.
    return refused;
  }
  try {
    // The umask may have narrowed the mode `open` asked for.
    await handle.chmod(mode);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } catch {
    await handle.close().catch(() => {});
    await unlink(temp).catch(() => {});
    return refused;
  }
  await handle.close();

  // 4. Into place, then the result checked again.
  try {
    await rename(temp, target);
  } catch {
    await unlink(temp).catch(() => {});
    return refused;
  }
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    return refused;
  }
  if (!within(rootReal, real) || !allowed(libraryRelative(rootReal, real), false)) {
    await unlink(target).catch(() => {});
    return refused;
  }
  return { ok: true, real };
}
