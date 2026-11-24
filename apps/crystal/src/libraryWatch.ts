import * as fs from 'node:fs';
import { basename, isAbsolute, join, sep } from 'node:path';
import { MAX_CHANGED_PATHS, MAX_LIBRARY_PATH } from '@crystal-bridge/protocol';
import { checkLibraryPath, comparablePath, libraryRelative, type Filter } from './libraryPaths.js';

export type LibraryChange = { paths?: string[]; all?: true };

export type LibraryWatcher = {
  /** Some changes may go unseen: Linux reached `maxFolders` or ran out of watches, or a watch failed. Stays true once set. */
  readonly capped: boolean;
  /** How many `fs.watch` handles are open. */
  readonly watchCount: number;
  close(): void;
};

export type WatchOptions = {
  allowed: Filter;
  onChange: (change: LibraryChange) => void;
  /** The top-level `.gitignore` changed: the filter should be reloaded (and the watcher restarted with it). */
  onIgnoreChanged?: () => void;
  log: (msg: string) => void;
  batchMs?: number;
  maxFolders?: number;
  platform?: NodeJS.Platform;
  watch?: typeof fs.watch;
};

/**
 * Watches the Library and reports changed paths in batches, skipping what the listing leaves out (docs/LIBRARY.md,
 * "Keep watch").
 *
 * - A path that is a Tome (a Library file the filter allows) is reported when it is made, changed or removed.
 * - A path that isn't a Tome names a folder, and only a `rename` event counts for one (a folder's own `change` is its
 *   modified time moving, which Windows reports when something inside it changes, so it is dropped). One made or
 *   renamed in is reported with every Tome under it; one
 *   removed or renamed away is reported by its own path alone, since what was under it is gone, so a listing should
 *   drop or reload everything under that path. A removed file of another kind can't be told from a removed folder
 *   and is reported the same way, which costs only a needless reload.
 * - A change to the top-level `.gitignore` calls `onIgnoreChanged` and reports the whole listing as changed. The
 *   filter in use is the one given, so the caller reloads it and starts a new watcher.
 * - Past `MAX_CHANGED_PATHS` in a batch, when an event names no path, or when a watch fails (and so the watcher is
 *   `capped`), the batch says `all`.
 * - What the listing leaves out is never reported: a path longer than `MAX_LIBRARY_PATH`, and outside Windows a name
 *   with a `\`, which would be read and written as a different path.
 * - Nor is the Library folder itself, or a path outside it: macOS names an event on the watched folder by its own name
 *   (so one of that name that isn't in the Library is dropped), and Windows names it by its absolute path.
 *
 * On macOS and Windows one recursive watch covers the folder. On Linux, where the recursive watch puts a watch on
 * every file and can't skip a folder, the tree is walked (following no symlinks, skipping left-out folders) with one
 * watch per folder, up to `maxFolders`. Every watch error goes to `log`; none is thrown.
 */
export function watchLibrary(root: string, opts: WatchOptions): LibraryWatcher {
  const { allowed, onChange, log } = opts;
  const batchMs = opts.batchMs ?? 500;
  const maxFolders = opts.maxFolders ?? 5000;
  const platform = opts.platform ?? process.platform;
  const watch = opts.watch ?? fs.watch;
  const recursive = platform === 'darwin' || platform === 'win32';

  const watches = new Map<string, fs.FSWatcher>();
  const pending = new Set<string>();
  let all = false;
  let capped = false;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;

  const abs = (rel: string) => (rel === '' ? root : join(root, ...rel.split('/')));
  const child = (folder: string, name: string) => (folder === '' ? name : folder + '/' + name);

  function flush(): void {
    timer = undefined;
    if (closed) return;
    const change: LibraryChange =
      all || pending.size > MAX_CHANGED_PATHS ? { all: true } : { paths: [...pending].sort() };
    pending.clear();
    all = false;
    onChange(change);
  }

  function schedule(): void {
    if (!timer && !closed) timer = setTimeout(flush, batchMs);
  }

  function report(path: string): void {
    if (all) return;
    pending.add(path);
    // Past the limit the batch says `all`; holding more paths would only cost memory.
    if (pending.size > MAX_CHANGED_PATHS) {
      log(`Library reloads all: more than ${MAX_CHANGED_PATHS} paths`);
      all = true;
      pending.clear();
    }
    schedule();
  }

  function reportAll(reason: string): void {
    log(`Library reloads all: ${reason}`);
    all = true;
    pending.clear();
    schedule();
  }

  const isTome = (rel: string) => checkLibraryPath(rel).ok && allowed(rel, false);
  /** A name the listing leaves out wherever it is: see `library.ts`. */
  const unlisted = (name: string) => platform !== 'win32' && name.includes('\\');

  function close(rel: string): void {
    const watcher = watches.get(rel);
    if (!watcher) return;
    watches.delete(rel);
    try {
      watcher.close();
    } catch {
      // Already gone with its folder.
    }
  }

  /** Closes the watches on a folder and everything under it. */
  function closeUnder(rel: string): void {
    for (const key of [...watches.keys()]) {
      if (key === rel || (rel === '' ? true : key.startsWith(rel + '/'))) close(key);
    }
  }

  function addWatch(rel: string): boolean {
    if (closed) return false;
    if (watches.size >= maxFolders) {
      capped = true;
      return false;
    }
    let watcher: fs.FSWatcher;
    try {
      watcher = recursive
        ? watch(root, { recursive: true }, (event, name) => onRecursiveEvent(event, name))
        : watch(abs(rel), (event, name) => onFolderEvent(rel, watcher, event, name));
    } catch (error) {
      log(`Library watch on ${rel || '.'} failed: ${(error as Error).message}`);
      // Out of watches (ENOSPC) or a folder we may not read: either way some changes won't show.
      capped = true;
      return false;
    }
    watcher.on('error', (error: Error) => {
      if (watches.get(rel) === watcher) close(rel);
      // Changes there go unseen from now on, so clients reload rather than trust what they have.
      capped = true;
      reportAll(`watch on ${rel || '.'} failed: ${error.message}`);
    });
    watches.set(rel, watcher);
    return true;
  }

  /**
   * Walks a folder, following no symlinks and skipping what the filter leaves out. `watching` adds a watch per folder
   * (Linux); `reporting` reports each Tome found (a folder made or renamed in while watched).
   */
  function walk(rel: string, watching: boolean, reporting: boolean): void {
    if (closed) return;
    // The watch comes before the listing, so a file made in between is seen by one or the other.
    if (watching && !watches.has(rel) && !addWatch(rel)) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs(rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = child(rel, entry.name);
      if (unlisted(entry.name) || path.length > MAX_LIBRARY_PATH) continue;
      if (entry.isDirectory()) {
        if (allowed(path, true)) walk(path, watching, reporting);
      } else if (reporting && isTome(path)) {
        report(path);
      }
      if (reporting && all && !watching) return;
    }
  }

  /** One changed path, relative to the Library with `/` between its parts. */
  function changed(path: string, event: string): void {
    if (path.length > MAX_LIBRARY_PATH) return;
    if (path === '.gitignore') {
      opts.onIgnoreChanged?.();
      reportAll('.gitignore changed');
      return;
    }
    let stats: fs.Stats | undefined;
    try {
      stats = fs.lstatSync(abs(path));
    } catch {
      stats = undefined;
    }
    if (stats?.isDirectory()) {
      // A folder's own `change` is its modified time moving because something in it changed (Windows reports it,
      // and Crystal's own temp files cause it). What changed is reported by its own event.
      if (event === 'change') return;
      if (!allowed(path, true)) return;
      report(path);
      // A watch already here can be on a folder removed and made again at this path (Linux watches the old one).
      if (!recursive) closeUnder(path);
      walk(path, !recursive, true);
      return;
    }
    if (isTome(path)) {
      report(path);
      return;
    }
    if (stats) {
      // A file of another kind, or a symlink to a folder, which the watcher doesn't follow.
      if (stats.isSymbolicLink() && allowed(path, true)) report(path);
      return;
    }
    // Gone, and not a Tome: a folder removed or renamed away (see above).
    if (!recursive) closeUnder(path);
    if (allowed(path, true)) report(path);
  }

  // The Library's own path in each spelling an event can use: as given, and its real path (on Windows with long
  // names for short ones such as `RUNNER~1`; on macOS through `/private`).
  const rootForms = [root];
  try {
    rootForms.push(fs.realpathSync.native(root));
  } catch {
    // Not there (yet): an event names it as given, if at all.
  }

  /**
   * The Library path a recursive event names, or undefined for the Library itself or a path outside it, which are
   * never reported.
   */
  function recursivePath(raw: string): string | undefined {
    const plain = comparablePath(raw, platform);
    // Windows names the watched folder by its absolute path (with the long-path prefix) when it is removed.
    if (isAbsolute(plain)) {
      for (const form of rootForms) {
        const path = libraryRelative(comparablePath(form, platform), plain);
        if (path) return path;
      }
      return undefined;
    }
    const path = plain.split(sep).join('/').split('\\').join('/').replace(/\/+$/, '');
    if (path === '') return undefined;
    // FSEvents names an event on the watched folder itself (its making, just before the watch began, say) by the
    // folder's own name, as if it were in it. Only an entry of that name really in the Library is one of its paths.
    if (platform === 'darwin' && path === basename(root) && !fs.existsSync(join(root, path))) return undefined;
    return path;
  }

  function onRecursiveEvent(event: string, name: string | Buffer | null): void {
    if (closed) return;
    if (name === null) return reportAll('an event without a file name');
    const raw = name.toString();
    if (unlisted(raw)) return;
    const path = recursivePath(raw);
    if (path !== undefined) changed(path, event);
  }

  function onFolderEvent(rel: string, watcher: fs.FSWatcher, event: string, name: string | Buffer | null): void {
    // A watch closed meanwhile, or one left on a folder that has since moved: the parent's event covers it.
    if (closed || watches.get(rel) !== watcher) return;
    if (!fs.existsSync(abs(rel))) {
      closeUnder(rel);
      return;
    }
    if (name === null) return reportAll('an event without a file name');
    if (unlisted(name.toString())) return;
    changed(child(rel, name.toString()), event);
  }

  if (recursive) addWatch('');
  else walk('', true, false);

  return {
    get capped() {
      return capped;
    },
    get watchCount() {
      return watches.size;
    },
    close() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      closeUnder('');
      pending.clear();
    },
  };
}
