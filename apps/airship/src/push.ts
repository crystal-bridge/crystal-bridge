import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import webpush from 'web-push';
import { z } from 'zod';
import { type Attention, type PushSubscriptionJson, pushNotificationFor } from '@crystal-bridge/protocol';
import type { Store } from './store.js';

const VapidKeys = z.object({ publicKey: z.string().min(1), privateKey: z.string().min(1) });
export type VapidKeys = z.infer<typeof VapidKeys>;

/**
 * The hub's VAPID key pair, made on first start and kept in `path` (owner-only): browsers tie a subscription to the
 * public key, so losing the file means every device has to subscribe again.
 */
export function loadVapidKeys(path: string): VapidKeys {
  if (existsSync(path)) return VapidKeys.parse(JSON.parse(readFileSync(path, 'utf8')));
  const keys = webpush.generateVAPIDKeys();
  writeFileSync(path, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
  return keys;
}

/**
 * Delivers one encrypted payload; rejects with an error carrying the push service's `statusCode` when it refuses.
 * A push with the same `topic` replaces one the device hasn't received yet.
 */
export type PushSend = (subscription: PushSubscriptionJson, payload: string, topic: string) => Promise<unknown>;

export function webPushSender(keys: VapidKeys, subject: string): PushSend {
  return (subscription, payload, topic) =>
    webpush.sendNotification(subscription, payload, {
      vapidDetails: { subject, ...keys },
      TTL: 60 * 60,
      urgency: 'high',
      topic,
    });
}

export interface Pusher {
  notify(attention: Attention): Promise<void>;
}

/** Push service answers that mean the subscription will never work again. */
const GONE = new Set([404, 410]);

export function createPusher(options: { store: Store; send: PushSend; onError?: (error: unknown) => void }): Pusher {
  const { store, send, onError = () => {} } = options;
  return {
    async notify(attention) {
      const deliveries = store.listPushSubscriptions().map(async ({ subscription, prefs }) => {
        const text = pushNotificationFor(attention, prefs);
        if (!text) return;
        const { node, session } = attention;
        try {
          // Topics are at most 32 URL-safe characters: a session id without its dashes.
          await send(
            subscription,
            JSON.stringify({ ...text, tag: session, node, session }),
            session.replaceAll('-', ''),
          );
        } catch (error) {
          const status = (error as { statusCode?: unknown }).statusCode;
          if (typeof status === 'number' && GONE.has(status)) store.deletePushSubscription(subscription.endpoint);
          else onError(error);
        }
      });
      await Promise.all(deliveries);
    },
  };
}
