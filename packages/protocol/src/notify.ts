import { z } from 'zod';
import type { Attention } from './commands.js';

/** Per Kingdom, per device. Discreet names only the Kingdom (this device's name for it) and the kind of event. */
export const NotifyLevel = z.enum(['full', 'discreet', 'off']);
export type NotifyLevel = z.infer<typeof NotifyLevel>;

const TITLES: Record<Attention['reason'], string> = {
  'needs-you': 'needs you',
  done: 'finished a turn',
  failed: 'hit an error',
  'cast-done': 'finished a job',
  'cast-failed': 'had a job fail',
};

/** The notification to show for an attention frame, or null when this Kingdom's notifications are off. */
export function notificationFor(
  attention: Attention,
  kingdomName: string,
  level: NotifyLevel,
): { title: string; body: string } | null {
  if (level === 'off') return null;
  const title = `${kingdomName} ${TITLES[attention.reason]}`;
  if (level === 'discreet') return { title, body: 'Open Crystal Bridge to see it.' };

  let what: string | undefined;
  if (attention.reason === 'needs-you') {
    what =
      attention.detail === 'AskUserQuestion' ? 'a question for you' : `approval for ${attention.detail ?? 'a tool'}`;
  } else if (attention.reason !== 'failed') {
    what = attention.detail;
  }
  return { title, body: what ? `${attention.label}: ${what}` : attention.label };
}

/**
 * One device's notification choices, as it tells the hub for Web Push: its names for Kingdoms, the Kingdoms it hides,
 * and a level per Kingdom (unset means full). The hub renders each push from these, so for a Discreet Kingdom only
 * the generic text ever leaves it.
 */
export const PushPrefs = z.object({
  names: z.record(z.string(), z.string()),
  hidden: z.array(z.string()),
  notify: z.record(z.string(), NotifyLevel).optional(),
});
export type PushPrefs = z.infer<typeof PushPrefs>;

/** A browser's `PushSubscription.toJSON()`, the part a sender needs. */
export const PushSubscriptionJson = z.object({
  endpoint: z.url({ protocol: /^https$/ }),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});
export type PushSubscriptionJson = z.infer<typeof PushSubscriptionJson>;

/** Body of `PUT /api/push/subscription`: subscribe this device, or update its prefs. */
export const PushSubscriptionPut = z.object({ subscription: PushSubscriptionJson, prefs: PushPrefs });
export type PushSubscriptionPut = z.infer<typeof PushSubscriptionPut>;

/** What a push to one device says, or null when that device hides the Kingdom or turned it off. */
export function pushNotificationFor(attention: Attention, prefs: PushPrefs): { title: string; body: string } | null {
  if (prefs.hidden.includes(attention.node)) return null;
  const name = prefs.names[attention.node] || attention.node;
  return notificationFor(attention, name, prefs.notify?.[attention.node] ?? 'full');
}
