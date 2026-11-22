import { useSyncExternalStore } from 'react';
import { readPref as read, subscribePrefs as subscribe, writePref as write } from './devicePrefs.js';

/**
 * This device's choices for a Board (shown by Kingdom and Scout): its mode, and which project sections are folded.
 */
export type BoardMode = 'projects' | 'tiles';

const MODE_PREFIX = 'crystal-bridge.board-mode.';
const FOLDS_PREFIX = 'crystal-bridge.board-folds.';
// useSyncExternalStore needs the same Set back until the saved text changes.
const parsed = new Map<string, { raw: string; set: ReadonlySet<string> }>();

function boardMode(node: string, scout: string): BoardMode {
  return read(`${MODE_PREFIX}${node}.${scout}`) === 'tiles' ? 'tiles' : 'projects';
}

function parseNames(raw: string | null): ReadonlySet<string> {
  if (raw === null) return new Set();
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value) && value.every((name) => typeof name === 'string')) return new Set(value as string[]);
  } catch {
    // Corrupt: read as no folds.
  }
  return new Set();
}

function folded(node: string, scout: string): ReadonlySet<string> {
  const key = `${FOLDS_PREFIX}${node}.${scout}`;
  const raw = read(key) ?? '';
  const cached = parsed.get(key);
  if (cached && cached.raw === raw) return cached.set;
  const set = parseNames(raw === '' ? null : raw);
  parsed.set(key, { raw, set });
  return set;
}

/** Whether a Board shows its projects or its tiles on this device, and a way to change it. */
export function useBoardMode(node: string, scout: string): [BoardMode, (mode: BoardMode) => void] {
  const mode = useSyncExternalStore(subscribe, () => boardMode(node, scout));
  return [mode, (next) => write(`${MODE_PREFIX}${node}.${scout}`, next)];
}

/** The project sections a Board has folded on this device, and a toggle for one by name. */
export function useFolded(node: string, scout: string): [ReadonlySet<string>, (name: string) => void] {
  const names = useSyncExternalStore(subscribe, () => folded(node, scout));
  const toggle = (name: string): void => {
    const next = new Set(folded(node, scout));
    if (!next.delete(name)) next.add(name);
    write(`${FOLDS_PREFIX}${node}.${scout}`, JSON.stringify([...next]));
  };
  return [names, toggle];
}
