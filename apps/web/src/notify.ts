import type { NotifyLevel } from '@crystal-bridge/protocol';

// The text itself lives in the protocol package: the hub renders Web Push with the same words.
export { notificationFor, type NotifyLevel } from '@crystal-bridge/protocol';

/**
 * Whether the user is looking at this session right now, so it needn't notify. Visible isn't enough: macOS Chrome
 * reports a window sitting behind another app as visible, so the window must also have focus.
 */
export function isLooking(
  shown: string | null,
  session: string,
  page: Pick<Document, 'visibilityState' | 'hasFocus'> = document,
): boolean {
  return shown === session && page.visibilityState === 'visible' && page.hasFocus();
}

export const NOTIFY_LEVELS: { value: NotifyLevel; label: string }[] = [
  { value: 'full', label: 'Full' },
  { value: 'discreet', label: 'Discreet' },
  { value: 'off', label: 'Off' },
];
