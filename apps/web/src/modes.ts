import type { PermissionMode } from '@crystal-bridge/protocol';

/** Display names for the modes a client may pick, in menu order. */
export const MODES: { value: PermissionMode; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'manual', label: 'Ask every time' },
  { value: 'plan', label: 'Plan only' },
];

const STORAGE_KEY = 'crystal-bridge.mode';

/** This device's choice for new sessions; auto unless it picked another. */
export function loadDefaultMode(storage: Storage | undefined = globalThis.localStorage): PermissionMode {
  try {
    const saved = storage?.getItem(STORAGE_KEY);
    return MODES.find((mode) => mode.value === saved)?.value ?? 'auto';
  } catch {
    return 'auto';
  }
}

export function saveDefaultMode(mode: PermissionMode, storage: Storage | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(STORAGE_KEY, mode);
  } catch {
    // Not saved; the choice still applies to this page.
  }
}
