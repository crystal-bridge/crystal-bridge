import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import {
  MAX_IMAGE_BYTES,
  MAX_LIBRARY_PATH,
  MAX_LISTING,
  MAX_TOME_BYTES,
  type LibraryBacklink,
  type LibraryEntry,
  type LibraryTome,
  type TomeVersion,
} from '@crystal-bridge/protocol';
import { checkLibraryPath, libraryFilter, resolveForRead, writeTome, type Filter } from './libraryPaths.js';
import { createLinkIndex, type LinkIndex } from './libraryLinks.js';
import { watchLibrary, type LibraryChange, type LibraryWatcher } from './libraryWatch.js';

type Refusal = { ok: false; reason: string };
export type ListAnswer = { ok: true; entries: LibraryEntry[]; truncated?: true } | Refusal;
export type ReadAnswer = { ok: true; tome: LibraryTome } | Refusal;
export type WriteAnswer = { ok: true; version: TomeVersion } | { ok: false; reason: string; version?: TomeVersion };
export type BacklinksAnswer = { ok: true; backlinks: LibraryBacklink[] } | Refusal;

export type Library = {
  /** The Library folder, as configured. */
  readonly dir: string;
  /** Makes the folder if it's missing and starts watching it. */
  start(): Promise<void>;
  stop(): void;
  list(): Promise<ListAnswer>;
  /** A Tome as text, or an image (`as: 'image'`) as base64. */
  read(path: string, as?: 'image'): Promise<ReadAnswer>;
  /** Writes a Markdown Tome; `base` is the version it was edited from, or null to make a new one. */
  write(path: string, content: string, base: TomeVersion | null): Promise<WriteAnswer>;
  backlinks(path: string): Promise<BacklinksAnswer>;
};

export type LibraryOptions = {
  dir: string;
  log: (msg: string) => void;
  onChange?: (change: LibraryChange) => void;
  maxListing?: number;
};

/** The Library folder from `CRYSTAL_LIBRARY_DIR` (docs/LIBRARY.md): `off`, unset for the default, or a folder. */
export function libraryDirFrom(env: Record<string, string | undefined>, home: string): string | undefined {
  const value = env.CRYSTAL_LIBRARY_DIR;
  if (value === 'off') return undefined;
  // Resolved once, at start: a relative folder would otherwise be taken from each Quest's own project folder.
  return value ? resolve(value) : join(home, '.crystal-bridge', 'library');
}

const NOT_HERE = 'not in the Library';
const refused: Refusal = { ok: false, reason: NOT_HERE };

/** The names coding agents load as instructions; New Tome won't make them, since a Library can be a project folder. */
const INSTRUCTIONS = new Set(['claude.md', 'agents.md']);

const CHUNK = 64 * 1024;

/** The protocol carries a reason of up to 300 characters; a long folder path keeps its end, which tells folders apart. */
const FOLDER_IN_REASON = 250;
function folderForReason(dir: string): string {
  return dir.length <= FOLDER_IN_REASON ? dir : '…' + dir.slice(-FOLDER_IN_REASON);
}

/**
 * A name the Library leaves out outside Windows: a `\` is a separator only there, so elsewhere `a\b.md` would be
 * read and written as `a/b.md`, another file.
 */
const unlisted = (name: string) => process.platform !== 'win32' && name.includes('\\');

function within(folder: string, path: string): boolean {
  return path === folder || path.startsWith(folder + sep);
}

function libraryRelative(rootReal: string, real: string): string {
  return relative(rootReal, real).split(sep).join('/');
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/**
 * Reads a file through one handle: its version (size, modified time and the hash of every byte) and at most `keep`
 * bytes of it. The handle's own stat is used, so the version describes the bytes read.
 */
async function readVersioned(
  real: string,
  keep: number,
): Promise<{ bytes: Buffer; truncated: boolean; version: TomeVersion }> {
  const handle = await open(real, 'r');
  try {
    const info = await handle.stat();
    const hash = createHash('sha256');
    const kept: Buffer[] = [];
    let keptBytes = 0;
    let total = 0;
    const buffer = Buffer.alloc(CHUNK);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      total += bytesRead;
      if (keptBytes < keep) {
        const part = chunk.subarray(0, Math.min(bytesRead, keep - keptBytes));
        kept.push(Buffer.from(part));
        keptBytes += part.length;
      }
    }
    return {
      bytes: Buffer.concat(kept),
      truncated: total > keep,
      version: { size: total, mtimeMs: info.mtimeMs, hash: hash.digest('hex') },
    };
  } finally {
    await handle.close();
  }
}

/**
 * One Kingdom's Library (docs/LIBRARY.md): lists, reads and writes it through the checks in `libraryPaths.ts`, and
 * watches it, reloading the filter when the top-level `.gitignore` changes. Every refusal of a path says
 * `not in the Library`, whether the file is missing or was refused, so a refusal never says what exists.
 */
export function createLibrary(opts: LibraryOptions): Library {
  const { dir, log } = opts;
  const maxListing = opts.maxListing ?? MAX_LISTING;
  let filter: Filter = libraryFilter(dir);
  // Read through this, so a reloaded filter applies to the next request at once.
  const allowed: Filter = (path, isFolder) => filter(path, isFolder);
  let watcher: LibraryWatcher | undefined;
  let running = false;
  const index: LinkIndex = createLinkIndex({
    list: async () => {
      const answer = await list();
      return answer.ok ? answer.entries.filter((e) => e.kind !== 'folder') : [];
    },
    read: async (path) => {
      const answer = await read(path);
      return answer.ok && answer.tome.kind === 'md' ? answer.tome.content : undefined;
    },
  });
  const changed = (change: LibraryChange): void => {
    index.changed(change);
    opts.onChange?.(change);
  };

  function startWatching(): void {
    watcher = watchLibrary(dir, {
      allowed,
      log,
      onChange: changed,
      onIgnoreChanged: () => {
        filter = libraryFilter(dir);
        log('Library .gitignore changed: reloading its filter');
        // Not from inside the old watcher's own callback; it is closed before its batch, so say `all` here.
        setImmediate(() => {
          if (!running) return;
          watcher?.close();
          startWatching();
          changed({ all: true });
        });
      },
    });
    if (watcher.capped) log('Library watch is capped: some folders go unwatched');
  }

  async function start(): Promise<void> {
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      log(`Library folder ${dir} can't be made: ${(error as Error).message}`);
    }
    filter = libraryFilter(dir);
    running = true;
    startWatching();
    // Not awaited: the first listing doesn't wait for the links.
    void index.rebuild();
  }

  function stop(): void {
    running = false;
    index.stop();
    watcher?.close();
    watcher = undefined;
  }

  async function list(): Promise<ListAnswer> {
    const gone = `the Library folder is gone: ${folderForReason(dir)}`;
    let rootReal: string;
    try {
      rootReal = await realpath(dir);
      if (!(await stat(rootReal)).isDirectory()) return { ok: false, reason: gone };
      await readdir(rootReal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: gone };
      return { ok: false, reason: `the Library folder can't be read: ${folderForReason(dir)}` };
    }

    const entries: LibraryEntry[] = [];
    let truncated = false;

    const add = (entry: LibraryEntry): boolean => {
      if (entries.length >= maxListing) {
        truncated = true;
        return false;
      }
      entries.push(entry);
      return true;
    };

    // `ancestors` holds the real paths of the folders above, so a symlink back up the tree isn't followed round.
    async function walk(rel: string, real: string, ancestors: Set<string>): Promise<void> {
      let dirents: Dirent[];
      try {
        dirents = await readdir(real, { withFileTypes: true });
      } catch {
        // A folder below the top that can't be read is left out, not the whole listing.
        return;
      }
      dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const dirent of dirents) {
        if (truncated) return;
        const path = rel === '' ? dirent.name : rel + '/' + dirent.name;
        // Too long for a message; a folder's contents are longer still.
        if (unlisted(dirent.name) || path.length > MAX_LIBRARY_PATH) continue;
        const full = join(real, dirent.name);
        let isFolder = dirent.isDirectory();
        let target = full;
        if (dirent.isSymbolicLink()) {
          // Listed only if it stays inside and passes the filter where it leads, as `resolveForRead` requires.
          try {
            target = await realpath(full);
            isFolder = (await stat(target)).isDirectory();
          } catch {
            continue;
          }
          if (target === rootReal || !within(rootReal, target)) continue;
          if (!allowed(libraryRelative(rootReal, target), isFolder)) continue;
        } else if (!isFolder && !dirent.isFile()) {
          continue;
        }
        if (isFolder) {
          if (!checkFolderName(path) || !allowed(path, true) || ancestors.has(target)) continue;
          if (!add({ path, kind: 'folder' })) return;
          await walk(path, target, new Set(ancestors).add(target));
          continue;
        }
        const check = checkLibraryPath(path);
        if (!check.ok || !check.kind || !allowed(path, false)) continue;
        if (target !== full) {
          const there = checkLibraryPath(libraryRelative(rootReal, target));
          if (!there.ok || there.kind !== check.kind) continue;
        }
        let info;
        try {
          info = await stat(full);
        } catch {
          continue;
        }
        if (!add({ path, kind: check.kind, size: info.size, mtimeMs: info.mtimeMs })) return;
      }
    }

    await walk('', rootReal, new Set([rootReal]));
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return truncated ? { ok: true, entries, truncated: true } : { ok: true, entries };
  }

  async function read(path: string, as?: 'image'): Promise<ReadAnswer> {
    const resolved = await resolveForRead(dir, path, allowed);
    if (!resolved.ok) return refused;
    const { real, kind } = resolved;
    if (as === 'image' && kind !== 'image') return { ok: false, reason: 'not an image' };
    const shown = path.split(/[/\\]/).join('/');

    let link = false;
    try {
      link = (await lstat(join(dir, ...shown.split('/')))).isSymbolicLink();
    } catch {
      return refused;
    }

    try {
      if (kind === 'image') {
        if ((await stat(real)).size > MAX_IMAGE_BYTES) return { ok: false, reason: 'too large' };
        const { bytes, truncated, version } = await readVersioned(real, MAX_IMAGE_BYTES);
        // Grown past the limit since the stat above.
        if (truncated) return { ok: false, reason: 'too large' };
        const tome: LibraryTome = {
          path: shown,
          kind,
          content: bytes.toString('base64'),
          encoding: 'base64',
          truncated: false,
          version,
        };
        if (link) tome.link = true;
        return { ok: true, tome };
      }

      const { bytes, truncated, version } = await readVersioned(real, MAX_TOME_BYTES);
      if (bytes.includes(0)) return { ok: false, reason: 'not text' };
      let content: string;
      try {
        // A cut can split a multi-byte character; streaming holds that tail back instead of calling it invalid.
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated });
      } catch {
        return { ok: false, reason: 'not text' };
      }
      // The version is the whole file's; `write` refuses a file over the limit, so a cut Tome is never saved over
      // the part that wasn't sent.
      const tome: LibraryTome = { path: shown, kind, content, encoding: 'utf8', truncated, version };
      if (link) tome.link = true;
      return { ok: true, tome };
    } catch {
      return refused;
    }
  }

  async function write(path: string, content: string, base: TomeVersion | null): Promise<WriteAnswer> {
    const check = checkLibraryPath(path, { write: true });
    if (!check.ok || !allowed(check.parts.join('/'), false)) return refused;
    const { parts } = check;
    const name = parts[parts.length - 1]!;
    if (base === null && INSTRUCTIONS.has(name.toLowerCase())) {
      return { ok: false, reason: 'coding agents load this name as instructions' };
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_TOME_BYTES) return { ok: false, reason: 'too large' };

    let rootReal: string;
    try {
      rootReal = await realpath(dir);
    } catch {
      return refused;
    }

    // The folders the Tome goes in: walk down to the deepest one that exists, whose real path must be inside the
    // Library and pass the filter; the rest are made. Their names already passed `checkLibraryPath`.
    const folders = parts.slice(0, -1);
    let existing = 0;
    for (; existing < folders.length; existing++) {
      const here = join(rootReal, ...folders.slice(0, existing + 1));
      try {
        if (!(await stat(here)).isDirectory()) return refused;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return refused;
        // A symlink to nowhere: making a folder there would follow it.
        try {
          await lstat(here);
          return refused;
        } catch {
          break;
        }
      }
    }
    let ancestor: string;
    try {
      ancestor = await realpath(join(rootReal, ...folders.slice(0, existing)));
    } catch {
      return refused;
    }
    if (!within(rootReal, ancestor) || !allowed(libraryRelative(rootReal, ancestor), true)) return refused;
    const missing = folders.slice(existing);

    // What is at the name now. The app never saves through a symlink; one that is visibly in the Library says so.
    let current: TomeVersion | undefined;
    if (missing.length === 0) {
      const target = join(ancestor, name);
      let exists = true;
      try {
        const info = await lstat(target);
        if (info.isSymbolicLink()) {
          return (await resolveForRead(dir, parts.join('/'), allowed)).ok ? { ok: false, reason: 'a link' } : refused;
        }
        if (!info.isFile()) return refused;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return refused;
        exists = false;
      }
      if (exists) {
        if (base === null) return { ok: false, reason: 'exists' };
        try {
          current = (await readVersioned(target, 0)).version;
        } catch {
          return refused;
        }
        // It was sent cut, so a save from it would drop everything past the cut.
        if (current.size > MAX_TOME_BYTES) return { ok: false, reason: 'too large to edit here' };
      }
    }
    if (base !== null) {
      if (!current) return { ok: false, reason: 'gone' };
      // Compared by hash alone: a touch that changes only the modified time isn't a change to the text. The file can
      // still change between this read and the rename in `writeTome`; the gap is kept to these few lines, and
      // closing it would need a lock no other editor of the folder takes.
      if (current.hash !== base.hash) return { ok: false, reason: 'changed', version: current };
    }

    if (missing.length > 0) {
      try {
        await mkdir(join(ancestor, ...missing), { recursive: true });
      } catch {
        return refused;
      }
    }
    const written = await writeTome(dir, parts.join('/'), content, allowed, { exclusive: base === null });
    if (!written.ok) return written;
    try {
      const info = await stat(written.real);
      const bytes = Buffer.from(content, 'utf8');
      return { ok: true, version: { size: bytes.length, mtimeMs: info.mtimeMs, hash: sha256(bytes) } };
    } catch {
      return refused;
    }
  }

  async function backlinks(path: string): Promise<BacklinksAnswer> {
    const resolved = await resolveForRead(dir, path, allowed);
    if (!resolved.ok) return refused;
    const shown = path.split(/[/\\]/).join('/');
    return { ok: true, backlinks: await index.backlinks(shown) };
  }

  return { dir, start, stop, list, read, write, backlinks };
}

/** A folder's own name passes the same lexical rules as a path to a file in it. */
function checkFolderName(path: string): boolean {
  // `checkLibraryPath` wants a file kind at the end, so test a Tome name inside the folder.
  return checkLibraryPath(path + '/x.md').ok;
}
