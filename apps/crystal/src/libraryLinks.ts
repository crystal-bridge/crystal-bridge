import { posix } from 'node:path';
import { parseWikiLink, type LibraryBacklink } from '@crystal-bridge/protocol';
import type { LibraryChange } from './libraryWatch.js';

export type Link = { target: string; line: string };

const WIKI = /\[\[([^\[\]\n]+?)\]\]/g;
const MARKDOWN = /\[[^\[\]\n]*\]\(([^()\s]+)(?:\s+"[^"]*")?\)/g;
const LINE_LIMIT = 200;

/**
 * The links in a Markdown text: wiki links by their target, and relative `.md` links resolved against `from`.
 * Fenced code and inline code are skipped.
 */
export function linksIn(text: string, from: string): Link[] {
  const out: Link[] = [];
  let fence: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(raw)?.[1];
    if (fence) {
      if (mark && mark[0] === fence[0] && mark.length >= fence.length) fence = undefined;
      continue;
    }
    if (mark) {
      fence = mark;
      continue;
    }
    const line = raw.replace(/(`+)[^`]*?\1/g, (m) => ' '.repeat(m.length));
    const here: { index: number; target: string }[] = [];
    for (const m of line.matchAll(WIKI)) {
      const target = parseWikiLink(m[1]!).target.trim();
      if (target) here.push({ index: m.index, target });
    }
    for (const m of line.matchAll(MARKDOWN)) {
      const target = relativeTarget(m[1]!, from);
      if (target) here.push({ index: m.index, target });
    }
    here.sort((a, b) => a.index - b.index);
    for (const { target } of here) out.push({ target, line: raw });
  }
  return out;
}

function relativeTarget(url: string, from: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('/') || url.startsWith('#')) return undefined;
  let path = url.split('#')[0]!.split('?')[0]!;
  try {
    path = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  if (!path.toLowerCase().endsWith('.md')) return undefined;
  const resolved = posix.normalize(posix.join(posix.dirname(from), path));
  return resolved.startsWith('..') || resolved === '.' ? undefined : resolved;
}

/** Fewest path segments first, then alphabetical: the tie rule of `resolveWikiLink`. */
function better(a: string, b: string): boolean {
  const da = a.split('/').length;
  const db = b.split('/').length;
  return da < db || (da === db && a < b);
}

/**
 * `resolveWikiLink` from the protocol as a lookup built once: every name a path answers to (its full name, its name
 * without `.md`, and each of those from any `/` on), lower-cased, maps to the path that wins it. `resolveWikiLink`
 * stays the reference; the tests check the two agree.
 */
export function wikiLinkResolver(paths: readonly string[]): (target: string) => string | undefined {
  const best = new Map<string, string>();
  for (const path of paths) {
    const full = path.toLowerCase();
    const names = full.endsWith('.md') ? [full, full.slice(0, -3)] : [full];
    for (const name of names) {
      let from = 0;
      for (;;) {
        const key = name.slice(from);
        const held = best.get(key);
        if (held === undefined || better(path, held)) best.set(key, path);
        const slash = name.indexOf('/', from);
        if (slash < 0) break;
        from = slash + 1;
      }
    }
  }
  return (target) => {
    const want = target.trim().toLowerCase();
    return want ? best.get(want) : undefined;
  };
}

export type LinkIndexOptions = {
  /** Every file in the Library; only Markdown ones are read for links. */
  list: () => Promise<{ path: string; kind: string }[]>;
  /** A Tome's text (the first 512 KB of a cut one), or undefined if it can't be read. */
  read: (path: string) => Promise<string | undefined>;
  refreshMs?: number;
};

export type LinkIndex = {
  rebuild(): Promise<void>;
  /** Asks for a rebuild; many changes within `refreshMs` cause one. */
  changed(change: LibraryChange | string[]): void;
  backlinks(path: string): Promise<LibraryBacklink[]>;
  stop(): void;
};

export function createLinkIndex(opts: LinkIndexOptions): LinkIndex {
  const refreshMs = opts.refreshMs ?? 3000;
  // Each Tome to the Tomes that link to it, with the linking lines, sorted by path: built once per rebuild.
  let backlinksTo = new Map<string, LibraryBacklink[]>();
  let current: Promise<void> | undefined;
  let again = false;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  async function build(): Promise<void> {
    const entries = await opts.list();
    const resolve = wikiLinkResolver(entries.map((e) => e.path));
    const next = new Map<string, LibraryBacklink[]>();
    for (const entry of entries) {
      if (entry.kind !== 'md') continue;
      let text: string | undefined;
      try {
        text = await opts.read(entry.path);
      } catch {
        text = undefined;
      }
      if (text === undefined) continue;
      // A line is listed once per Tome it links to, and a Tome linking itself isn't listed.
      const seen = new Set<string>();
      for (const link of linksIn(text, entry.path)) {
        const target = resolve(link.target);
        if (target === undefined || target === entry.path) continue;
        const key = target + '\0' + link.line;
        if (seen.has(key)) continue;
        seen.add(key);
        const line = { path: entry.path, line: link.line.trim().slice(0, LINE_LIMIT) };
        const list = next.get(target);
        if (list) list.push(line);
        else next.set(target, [line]);
      }
    }
    // Stable, so one Tome's lines keep their order.
    for (const list of next.values()) list.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    backlinksTo = next;
  }

  function rebuild(): Promise<void> {
    stopped = false;
    // A rebuild asked for while one runs follows it, so the last change is never missed.
    if (current) {
      again = true;
      return current;
    }
    current = (async () => {
      try {
        do {
          again = false;
          try {
            await build();
          } catch {
            // Keep the last index; the next change tries again.
          }
        } while (again && !stopped);
      } finally {
        current = undefined;
      }
    })();
    return current;
  }

  function changed(): void {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void rebuild();
    }, refreshMs);
  }

  async function backlinks(path: string): Promise<LibraryBacklink[]> {
    if (current) await current;
    return (backlinksTo.get(path) ?? []).map((b) => ({ ...b }));
  }

  function stop(): void {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
  }

  return { rebuild, changed, backlinks, stop };
}
