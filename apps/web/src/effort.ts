import type { Effort } from '@crystal-bridge/protocol';

/** The CLI's effort levels in menu order, with display names (#32). Unset ('') leaves the CLI's own default. */
export const EFFORTS: { value: Effort | ''; label: string }[] = [
  { value: '', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
];

export function effortLabel(effort: string | undefined): string | undefined {
  return effort ? (EFFORTS.find((e) => e.value === effort)?.label ?? effort) : undefined;
}

const STORAGE_KEY = 'crystal-bridge.effort';

/** This device's effort for new sessions; '' (the CLI's default) unless it picked one. */
export function loadDefaultEffort(storage: Storage | undefined = globalThis.localStorage): Effort | '' {
  try {
    const saved = storage?.getItem(STORAGE_KEY);
    return EFFORTS.find((e) => e.value === saved)?.value ?? '';
  } catch {
    return '';
  }
}

export function saveDefaultEffort(effort: Effort | '', storage: Storage | undefined = globalThis.localStorage): void {
  try {
    if (effort) storage?.setItem(STORAGE_KEY, effort);
    else storage?.removeItem(STORAGE_KEY);
  } catch {
    // Not saved; the choice still applies to this page.
  }
}
