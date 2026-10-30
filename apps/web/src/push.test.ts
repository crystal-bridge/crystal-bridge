import { describe, expect, it, vi } from 'vitest';
import { disablePush, enablePush, keyBytes, openTarget, prefsForPush, syncPush } from './push.js';

const json = { endpoint: 'https://push.example/a', keys: { p256dh: 'p', auth: 'a' } };

function fakeRegistration(existing: boolean) {
  let current: { toJSON: () => typeof json; unsubscribe: () => Promise<boolean> } | null = null;
  const make = () => ({ toJSON: () => json, unsubscribe: vi.fn(async () => ((current = null), true)) });
  if (existing) current = make();
  const pushManager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async () => (current = make())),
  };
  return { pushManager, current: () => current };
}

function fakeFetch() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/push/key') return new Response(JSON.stringify({ publicKey: 'AQID' }));
    return new Response(null, { status: init?.method ? 204 : 404 });
  });
}

describe('prefsForPush', () => {
  it('sends the hub only names, hidden Kingdoms and levels, never which tab is open', () => {
    expect(prefsForPush({ names: { n: 'A' }, hidden: ['m'], active: 'n', notify: { n: 'discreet' } })).toEqual({
      names: { n: 'A' },
      hidden: ['m'],
      notify: { n: 'discreet' },
    });
    expect(prefsForPush({ names: {}, hidden: [] })).toEqual({ names: {}, hidden: [] });
  });
});

describe('keyBytes', () => {
  it('decodes a base64url VAPID key', () => {
    expect([...keyBytes('AQID')]).toEqual([1, 2, 3]);
    expect([...keyBytes('-_8')]).toEqual([251, 255]);
  });
});

describe('openTarget', () => {
  it('reads the node and session a notification click asked to open', () => {
    expect(openTarget('?node=node-a&session=s1')).toEqual({ node: 'node-a', session: 's1' });
    expect(openTarget('?node=node-a')).toBeNull();
    expect(openTarget('')).toBeNull();
  });
});

describe('enablePush / syncPush / disablePush', () => {
  const prefs = { names: { n: 'A' }, hidden: [], active: 'n' };

  it('subscribes with the hub-s key and sends this device-s prefs', async () => {
    const registration = fakeRegistration(false);
    const fetchFn = fakeFetch();
    await enablePush(registration, prefs, fetchFn);
    expect(registration.pushManager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: keyBytes('AQID'),
    });
    const put = fetchFn.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect(put[0]).toBe('/api/push/subscription');
    expect(JSON.parse(put[1]!.body as string)).toEqual({
      subscription: json,
      prefs: { names: { n: 'A' }, hidden: [] },
    });
  });

  it('resends prefs only when this device is subscribed', async () => {
    const fetchFn = fakeFetch();
    expect(await syncPush(fakeRegistration(false), prefs, fetchFn)).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await syncPush(fakeRegistration(true), prefs, fetchFn)).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith('/api/push/subscription', expect.objectContaining({ method: 'PUT' }));
  });

  it('tells the hub to forget the device, then unsubscribes', async () => {
    const registration = fakeRegistration(true);
    const fetchFn = fakeFetch();
    await disablePush(registration, fetchFn);
    const del = fetchFn.mock.calls.find(([, init]) => init?.method === 'DELETE')!;
    expect(JSON.parse(del[1]!.body as string)).toEqual({ endpoint: json.endpoint });
    expect(registration.current()).toBeNull();
  });

  it('fails loudly when the hub has no push key', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 404 }));
    await expect(enablePush(fakeRegistration(false), prefs, fetchFn)).rejects.toThrow(/not set up/);
  });
});
