import type { PushPrefs } from '@crystal-bridge/protocol';
import type { KingdomPrefs } from './kingdoms.js';

/** The part of a service worker registration push needs, so tests can stand in for it. */
export interface PushRegistration {
  pushManager: {
    getSubscription(): Promise<{ toJSON(): unknown; unsubscribe(): Promise<boolean> } | null>;
    subscribe(options: {
      userVisibleOnly: boolean;
      applicationServerKey: Uint8Array<ArrayBuffer>;
    }): Promise<{ toJSON(): unknown }>;
  };
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export const pushSupported = (): boolean =>
  typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof PushManager !== 'undefined';

/** What the hub needs to render this device's pushes: never which tab is open. */
export function prefsForPush(prefs: KingdomPrefs): PushPrefs {
  const out: PushPrefs = { names: prefs.names, hidden: prefs.hidden };
  if (prefs.notify) out.notify = prefs.notify;
  return out;
}

/** A base64url VAPID public key as the bytes `subscribe` takes. */
export function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const base64 = key
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(key.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

/** The session a notification click opened the app at (`?node=&session=`), if any. */
export function openTarget(search: string): { node: string; session: string } | null {
  const params = new URLSearchParams(search);
  const node = params.get('node');
  const session = params.get('session');
  return node && session ? { node, session } : null;
}

async function put(subscription: { toJSON(): unknown }, prefs: KingdomPrefs, fetchFn: FetchFn): Promise<void> {
  const response = await fetchFn('/api/push/subscription', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subscription: subscription.toJSON(), prefs: prefsForPush(prefs) }),
  });
  if (!response.ok) throw new Error(`the hub refused the subscription (${response.status})`);
}

/** Subscribes this device to Web Push and tells the hub how to word its notifications. */
export async function enablePush(
  registration: PushRegistration,
  prefs: KingdomPrefs,
  fetchFn: FetchFn = fetch,
): Promise<void> {
  const response = await fetchFn('/api/push/key');
  const { publicKey } = (response.ok ? await response.json() : {}) as { publicKey?: string };
  if (!publicKey) throw new Error('Web Push is not set up on the hub');
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  await put(subscription, prefs, fetchFn);
}

/** Resends this device's prefs when it's subscribed; returns whether it is. */
export async function syncPush(
  registration: PushRegistration,
  prefs: KingdomPrefs,
  fetchFn: FetchFn = fetch,
): Promise<boolean> {
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return false;
  await put(subscription, prefs, fetchFn);
  return true;
}

/** Tells the hub to forget this device, then drops the browser's subscription. */
export async function disablePush(registration: PushRegistration, fetchFn: FetchFn = fetch): Promise<void> {
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  const { endpoint } = subscription.toJSON() as { endpoint: string };
  await fetchFn('/api/push/subscription', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  });
  await subscription.unsubscribe();
}
