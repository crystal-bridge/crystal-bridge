import { useSyncExternalStore } from 'react';

/**
 * This device's side-panel choices (shown by default), shared by every Quest view and Split View's shared panels,
 * so one toggle shows or hides the panel wherever it's drawn.
 */
export type PanelKey = 'details' | 'inventory';

const STORAGE: Record<PanelKey, string> = {
  details: 'crystal-bridge.details',
  inventory: 'crystal-bridge.inventory',
};
const listeners = new Set<() => void>();
// Storage can be missing or refuse writes (private windows); the choice still holds for this page.
const fallback: Partial<Record<PanelKey, boolean>> = {};

export function panelOpen(key: PanelKey): boolean {
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE[key]);
    if (saved !== null && saved !== undefined) return saved !== 'hidden';
  } catch {
    // Fall through to this page's choice.
  }
  return fallback[key] ?? true;
}

export function setPanelOpen(key: PanelKey, open: boolean): void {
  fallback[key] = open;
  try {
    globalThis.localStorage?.setItem(STORAGE[key], open ? 'shown' : 'hidden');
  } catch {
    // Not saved; the choice still applies to this page.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether a side panel is shown on this device, and a toggle for it. */
export function usePanel(key: PanelKey): [boolean, () => void] {
  const open = useSyncExternalStore(subscribe, () => panelOpen(key));
  return [open, () => setPanelOpen(key, !panelOpen(key))];
}
