import type { LibraryBacklink, LibraryEntry, LibraryTome, TomeVersion } from '@crystal-bridge/protocol';
import { useEffect, useState } from 'react';
import { refusal, UNREACHABLE } from './api.js';
import { readPref, writePref } from './devicePrefs.js';
import type { HubClient } from './hub.js';

/** A Kingdom's Library (docs/LIBRARY.md) as its listing says. */
export interface LibraryState {
  entries: LibraryEntry[];
  /** The Kingdom left entries out of a very long listing. */
  truncated: boolean;
  /** Why the listing couldn't be read ('that Kingdom is offline', or that it has no Library), as the hub said. */
  error?: string;
  /** The first listing is on its way. */
  loading: boolean;
}

const base = (node: string) => `/api/nodes/${encodeURIComponent(node)}/library`;
const pathQuery = (path: string) => `?path=${encodeURIComponent(path)}`;

/** Where a Library file (an image, or a Tome as bytes) is served. */
export const tomeFileUrl = (node: string, path: string) => `${base(node)}/file${pathQuery(path)}`;
/** Where an HTML Tome is served as a page, to show in a sandboxed frame. */
export const tomePageUrl = (node: string, path: string) => `${base(node)}/page${pathQuery(path)}`;

async function get<T>(url: string): Promise<T> {
  const response = await fetch(url).catch(() => {
    throw new Error(UNREACHABLE);
  });
  if (!response.ok) throw await refusal(response);
  return (await response.json()) as T;
}

/**
 * A Kingdom's Library listing: read on mount, again on a `library-changed` for the Kingdom and when the socket comes
 * back, with a watch held while mounted so the hub sends those frames. An answer that arrives after a newer request
 * went out is dropped. A refusal (offline, or no Library there) shows as `error`.
 */
export function useLibrary(hub: HubClient, node: string | undefined): LibraryState {
  const [state, setState] = useState<LibraryState>({ entries: [], truncated: false, loading: true });
  useEffect(() => {
    setState({ entries: [], truncated: false, loading: true });
    if (!node) return;
    let latest = 0;
    const load = () => {
      latest += 1;
      const round = latest;
      get<{ entries?: LibraryEntry[]; truncated?: boolean }>(base(node)).then(
        (listing) => {
          if (round === latest)
            setState({ entries: listing.entries ?? [], truncated: listing.truncated === true, loading: false });
        },
        (error: unknown) => {
          if (round === latest) {
            const reason = error instanceof Error ? error.message : String(error);
            setState({ entries: [], truncated: false, error: reason, loading: false });
          }
        },
      );
    };
    load();
    const unwatch = hub.watchLibrary(node);
    const stopChanged = hub.onLibraryChanged((frame) => {
      if (frame.node === node) load();
    });
    const stopReconnect = hub.onReconnect(load);
    return () => {
      latest += 1;
      unwatch();
      stopChanged();
      stopReconnect();
    };
  }, [hub, node]);
  return state;
}

/** Reads a Tome (or an image, as base64). */
export async function readTome(node: string, path: string): Promise<LibraryTome> {
  return (await get<{ tome: LibraryTome }>(`${base(node)}/tome${pathQuery(path)}`)).tome;
}

/** The Tomes that link to this one, each with the line that does. */
export async function backlinks(node: string, path: string): Promise<LibraryBacklink[]> {
  return (await get<{ backlinks?: LibraryBacklink[] }>(`${base(node)}/backlinks${pathQuery(path)}`)).backlinks ?? [];
}

export type TomeWrite = { saved: true; version: TomeVersion } | { saved: false; conflict: TomeVersion };

/**
 * Saves a Tome over the version it was read at (`base`, or null for a new file). A file that changed meanwhile is a
 * conflict carrying its current version. That's told by the body (`error: 'changed'` with a version), not the status,
 * since a Kingdom that doesn't answer in time is a 409 too; every other refusal throws.
 */
export async function writeTome(
  node: string,
  path: string,
  content: string,
  base_: TomeVersion | null,
): Promise<TomeWrite> {
  const response = await fetch(`${base(node)}/tome`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, content, base: base_ }),
  }).catch(() => {
    throw new Error(UNREACHABLE);
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string; version?: TomeVersion };
  if (response.ok && body.version) return { saved: true, version: body.version };
  if (response.status === 409 && body.error === 'changed' && body.version)
    return { saved: false, conflict: body.version };
  throw new Error(body.error ?? `The hub answered ${response.status}`);
}

const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1).toLowerCase();

/**
 * Files whose name matches `query`, best first: name starts with it, then a word in it does, then it's anywhere in the
 * name. Case is ignored; ties keep the listing's order. Folders are left out, and a blank query matches nothing.
 */
export function quickOpen(entries: readonly LibraryEntry[], query: string): LibraryEntry[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return [];
  const ranked: { entry: LibraryEntry; rank: number }[] = [];
  for (const entry of entries) {
    if (entry.kind === 'folder') continue;
    const name = fileName(entry.path);
    const at = name.indexOf(wanted);
    if (at < 0) continue;
    const rank = at === 0 ? 0 : /[^\p{L}\p{N}]/u.test(name[at - 1] ?? '') ? 1 : 2;
    ranked.push({ entry, rank });
  }
  return ranked.sort((a, b) => a.rank - b.rank).map((one) => one.entry);
}

const RECENT_MAX = 10;
const recentKey = (node: string) => `crystal-bridge.library-recent.${node}`;

/** The Tomes this device opened last in a Kingdom, most recent first. */
export function recentTomes(node: string): string[] {
  try {
    const saved: unknown = JSON.parse(readPref(recentKey(node)) ?? '[]');
    return Array.isArray(saved)
      ? saved.filter((one): one is string => typeof one === 'string').slice(0, RECENT_MAX)
      : [];
  } catch {
    return [];
  }
}

/** Notes that this device opened a Tome: it moves to the front, and only the last ten stay. */
export function rememberTome(node: string, path: string): void {
  const next = [path, ...recentTomes(node).filter((one) => one !== path)].slice(0, RECENT_MAX);
  writePref(recentKey(node), JSON.stringify(next));
}

/** The Library's purple, written out whole so the stylesheet build keeps the classes. */
export const LIBRARY_TONE = {
  bar: 'bg-purple-400 dark:bg-purple-500',
  text: 'text-purple-700 dark:text-purple-300',
  chip: 'bg-purple-100 text-purple-900 ring-purple-300 dark:bg-purple-950 dark:text-purple-200 dark:ring-purple-800',
  on: 'bg-purple-500 text-white ring-purple-600 dark:bg-purple-400 dark:text-purple-950 dark:ring-purple-300',
  wash: 'from-purple-100 dark:from-purple-950',
} as const;
