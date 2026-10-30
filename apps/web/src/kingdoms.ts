import type { SessionSummary } from './components/SessionList.js';
import type { NotifyLevel } from './notify.js';
import { applyOrder } from './tabOrder.js';

/** A Kingdom is a node: the hub keys sessions and usage by node id. */
export interface Kingdom {
  id: string;
  /** This device's name for it, or the node id. */
  name: string;
  connected: boolean;
  sessions: number;
}

/**
 * Per-device choices, kept in this browser only: what to call each Kingdom, which to hide entirely (no tab, no
 * sessions, no usage), and which tab was open. Another device sees its own choices.
 */
export interface KingdomPrefs {
  names: Record<string, string>;
  hidden: string[];
  active?: string;
  /** Notification level per Kingdom; unset means full. */
  notify?: Record<string, NotifyLevel>;
  /** Kingdom tab order on this device; Kingdoms not listed follow, sorted. */
  order?: string[];
  /** Quest tab order on this device, per Kingdom; Quests not listed follow, oldest first. */
  questOrder?: Record<string, string[]>;
}

export const EMPTY_PREFS: KingdomPrefs = { names: {}, hidden: [] };

const STORAGE_KEY = 'crystal-bridge.kingdoms';

export function listKingdoms(
  connected: readonly string[],
  sessions: readonly SessionSummary[],
  prefs: KingdomPrefs,
): { visible: Kingdom[]; hidden: Kingdom[] } {
  const counts = new Map<string, number>();
  for (const id of connected) counts.set(id, 0);
  for (const session of sessions) counts.set(session.node, (counts.get(session.node) ?? 0) + 1);

  const all = [...counts.keys()].sort().map((id) => ({
    id,
    name: prefs.names[id] || id,
    connected: connected.includes(id),
    sessions: counts.get(id) ?? 0,
  }));
  const hidden = new Set(prefs.hidden);
  const ordered = applyOrder(all, prefs.order);
  return { visible: ordered.filter((k) => !hidden.has(k.id)), hidden: all.filter((k) => hidden.has(k.id)) };
}

export function notifyLevel(prefs: KingdomPrefs, id: string): NotifyLevel {
  return prefs.notify?.[id] ?? 'full';
}

/** The Kingdom to show: the preferred one if it's visible, else the first visible one. */
export function pickActive(visible: readonly Kingdom[], preferred: string | undefined): string | null {
  if (preferred && visible.some((k) => k.id === preferred)) return preferred;
  return visible[0]?.id ?? null;
}

function isIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id) => typeof id === 'string');
}

function isPrefs(value: unknown): value is KingdomPrefs {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.names === 'object' &&
    v.names !== null &&
    !Array.isArray(v.names) &&
    Object.values(v.names).every((name) => typeof name === 'string') &&
    Array.isArray(v.hidden) &&
    v.hidden.every((id) => typeof id === 'string') &&
    (v.active === undefined || typeof v.active === 'string') &&
    (v.notify === undefined ||
      (typeof v.notify === 'object' &&
        v.notify !== null &&
        Object.values(v.notify).every((level) => level === 'full' || level === 'discreet' || level === 'off'))) &&
    (v.order === undefined || isIds(v.order)) &&
    (v.questOrder === undefined ||
      (typeof v.questOrder === 'object' &&
        v.questOrder !== null &&
        !Array.isArray(v.questOrder) &&
        Object.values(v.questOrder).every(isIds)))
  );
}

/** Storage can be missing or throw (private windows, blocked site data); fall back to defaults. */
export function loadPrefs(storage: Storage | undefined = globalThis.localStorage): KingdomPrefs {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : undefined;
    return isPrefs(parsed) ? parsed : EMPTY_PREFS;
  } catch {
    return EMPTY_PREFS;
  }
}

export function savePrefs(prefs: KingdomPrefs, storage: Storage | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Not saved; the choices still apply until the page reloads.
  }
}
