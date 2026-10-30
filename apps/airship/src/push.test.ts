import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Attention, PushSubscriptionJson } from '@crystal-bridge/protocol';
import { createPusher, loadVapidKeys, type PushSend } from './push.js';
import { openStore, type Store } from './store.js';

const session = '7d9f3c2e-1b4a-4c8e-9f00-123456789abc';
const attention: Attention = {
  kind: 'attention',
  node: 'node-a',
  session,
  label: 'Fix the login test',
  reason: 'needs-you',
  detail: 'Bash',
};

function sub(id: string): PushSubscriptionJson {
  return { endpoint: `https://push.example/${id}`, keys: { p256dh: 'p', auth: 'a' } };
}

describe('loadVapidKeys', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'airship-vapid-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('makes a key pair on first use, readable by the owner only, and reuses it after', () => {
    const path = join(dir, 'vapid.json');
    const first = loadVapidKeys(path);
    expect(first.publicKey).toMatch(/^[\w-]{80,}$/);
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(loadVapidKeys(path)).toEqual(first);
  });
});

describe('createPusher', () => {
  let store: Store;
  let sent: { endpoint: string; payload: Record<string, unknown> }[];
  let send: PushSend;

  beforeEach(() => {
    store = openStore(':memory:');
    sent = [];
    send = async (subscription, payload) => {
      sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) as Record<string, unknown> });
    };
  });
  afterEach(() => store.close());

  it('sends each device the text its own prefs call for, tagged with the session', async () => {
    store.putPushSubscription(sub('full'), { names: { 'node-a': 'Kingdom A' }, hidden: [] });
    store.putPushSubscription(sub('discreet'), { names: {}, hidden: [], notify: { 'node-a': 'discreet' } });
    store.putPushSubscription(sub('off'), { names: {}, hidden: [], notify: { 'node-a': 'off' } });
    store.putPushSubscription(sub('hidden'), { names: {}, hidden: ['node-a'] });

    await createPusher({ store, send }).notify(attention);

    expect(sent).toEqual([
      {
        endpoint: 'https://push.example/full',
        payload: {
          title: 'Kingdom A needs you',
          body: 'Fix the login test: approval for Bash',
          tag: session,
          node: 'node-a',
          session,
        },
      },
      {
        endpoint: 'https://push.example/discreet',
        payload: {
          title: 'node-a needs you',
          body: 'Open Crystal Bridge to see it.',
          tag: session,
          node: 'node-a',
          session,
        },
      },
    ]);
    expect(JSON.stringify(sent[1])).not.toMatch(/Fix the login test|Bash/);
  });

  it('forgets a subscription the push service says is gone, and keeps one that failed for other reasons', async () => {
    for (const id of ['gone', 'missing', 'flaky', 'fine'])
      store.putPushSubscription(sub(id), { names: {}, hidden: [] });
    const status: Record<string, number> = { gone: 410, missing: 404, flaky: 500 };
    const failing: PushSend = async (subscription, payload, topic) => {
      const code = status[subscription.endpoint.split('/').pop()!];
      if (code) throw Object.assign(new Error('push failed'), { statusCode: code });
      await send(subscription, payload, topic);
    };
    const errors: unknown[] = [];

    await createPusher({ store, send: failing, onError: (error) => errors.push(error) }).notify(attention);

    expect(sent.map((s) => s.endpoint)).toEqual(['https://push.example/fine']);
    expect(store.listPushSubscriptions().map((row) => row.subscription.endpoint)).toEqual([
      'https://push.example/flaky',
      'https://push.example/fine',
    ]);
    expect(errors).toHaveLength(1);
  });
});
