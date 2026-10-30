const PREFIX = 'crystal-bridge.draft.';

/**
 * Unsent text this device was typing (a New Quest prompt per Kingdom, a follow-up per Quest), so switching tabs in
 * the app or reloading doesn't lose it. Per device only; nothing is sent anywhere.
 */
export function loadDraft(key: string, storage: Storage | undefined = globalThis.localStorage): string {
  try {
    return storage?.getItem(PREFIX + key) ?? '';
  } catch {
    return '';
  }
}

export function saveDraft(key: string, text: string, storage: Storage | undefined = globalThis.localStorage): void {
  try {
    if (text === '') storage?.removeItem(PREFIX + key);
    else storage?.setItem(PREFIX + key, text);
  } catch {
    // Not saved; the text still stays in the box while it's open.
  }
}
