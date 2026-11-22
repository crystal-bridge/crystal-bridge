/**
 * This device's saved choices (a Board's mode, the Errands layout): text under a key in local storage, with a page-only
 * fallback, and one set of listeners for `useSyncExternalStore`.
 */
const listeners = new Set<() => void>();
// Storage can be missing or refuse writes (private windows); the choice still holds for this page.
const fallback = new Map<string, string>();

/** The saved text under `key`, or this page's choice when storage has none or can't be read. */
export function readPref(key: string): string | null {
  try {
    const saved = globalThis.localStorage?.getItem(key);
    if (saved !== null && saved !== undefined) return saved;
  } catch {
    // Fall through to this page's choice.
  }
  return fallback.get(key) ?? null;
}

/** Saves `value` under `key` (for this page at least) and tells every subscriber. */
export function writePref(key: string, value: string): void {
  fallback.set(key, value);
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Not saved; the choice still applies to this page.
  }
  for (const listener of listeners) listener();
}

export function subscribePrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
