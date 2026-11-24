import { posix } from 'node:path';
import { parseWikiLink, resolveWikiLink, type LibraryBacklink } from '@crystal-bridge/protocol';
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
  let files: string[] = [];
  let links = new Map<string, Link[]>();
  let current: Promise<void> | undefined;
  let again = false;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  async function build(): Promise<void> {
    const entries = await opts.list();
    const nextLinks = new Map<string, Link[]>();
    for (const entry of entries) {
      if (entry.kind !== 'md') continue;
      let text: string | undefined;
      try {
        text = await opts.read(entry.path);
      } catch {
        text = undefined;
      }
      if (text === undefined) continue;
      const found = linksIn(text, entry.path);
      if (found.length > 0) nextLinks.set(entry.path, found);
    }
    files = entries.map((e) => e.path);
    links = nextLinks;
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
    const out: LibraryBacklink[] = [];
    for (const [source, found] of links) {
      if (source === path) continue;
      const seen = new Set<string>();
      for (const link of found) {
        if (seen.has(link.line) || resolveWikiLink(link.target, files) !== path) continue;
        seen.add(link.line);
        out.push({ path: source, line: link.line.trim().slice(0, LINE_LIMIT) });
      }
    }
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }

  function stop(): void {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
  }

  return { rebuild, changed, backlinks, stop };
}
