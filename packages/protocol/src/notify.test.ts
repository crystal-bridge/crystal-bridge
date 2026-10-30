import { describe, expect, it } from 'vitest';
import { PushSubscriptionPut, notificationFor, pushNotificationFor } from './notify.js';

const base = { kind: 'attention' as const, node: 'n', session: 's', label: 'Fix the login test' };

describe('notificationFor', () => {
  it('Full: says which session and what it needs', () => {
    expect(notificationFor({ ...base, reason: 'needs-you', detail: 'Bash' }, 'node-b', 'full')).toEqual({
      title: 'node-b needs you',
      body: 'Fix the login test: approval for Bash',
    });
    expect(notificationFor({ ...base, reason: 'needs-you', detail: 'AskUserQuestion' }, 'node-b', 'full')?.body).toBe(
      'Fix the login test: a question for you',
    );
    expect(notificationFor({ ...base, reason: 'done', detail: 'All green.' }, 'node-b', 'full')).toEqual({
      title: 'node-b finished a turn',
      body: 'Fix the login test: All green.',
    });
    expect(notificationFor({ ...base, reason: 'failed' }, 'node-b', 'full')).toEqual({
      title: 'node-b hit an error',
      body: 'Fix the login test',
    });
  });

  it('Discreet: only this device-s name for the Kingdom and the kind of event, never the session or its content', () => {
    for (const reason of ['needs-you', 'done', 'failed'] as const) {
      const shown = notificationFor({ ...base, reason, detail: 'secret detail' }, 'Kingdom B', 'discreet')!;
      expect(shown.title.startsWith('Kingdom B')).toBe(true);
      expect(JSON.stringify(shown)).not.toMatch(/Fix the login test|secret detail|Bash/);
    }
  });

  it('Off: nothing', () => {
    expect(notificationFor({ ...base, reason: 'needs-you' }, 'node-b', 'off')).toBeNull();
  });
});

describe('pushNotificationFor', () => {
  const needs = { ...base, reason: 'needs-you' as const, detail: 'Bash' };

  it('renders with this device-s name and level for the Kingdom, full by default', () => {
    expect(pushNotificationFor(needs, { names: { n: 'Kingdom A' }, hidden: [] })).toEqual({
      title: 'Kingdom A needs you',
      body: 'Fix the login test: approval for Bash',
    });
    expect(pushNotificationFor(needs, { names: {}, hidden: [] })?.title).toBe('n needs you');
    expect(pushNotificationFor(needs, { names: {}, hidden: [], notify: { n: 'discreet' } })?.body).not.toMatch(
      /Fix the login test|Bash/,
    );
  });

  it('never notifies for a hidden Kingdom or one turned off', () => {
    expect(pushNotificationFor(needs, { names: {}, hidden: ['n'] })).toBeNull();
    expect(pushNotificationFor(needs, { names: {}, hidden: [], notify: { n: 'off' } })).toBeNull();
  });
});

describe('PushSubscriptionPut', () => {
  const subscription = { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } };

  it('takes a browser subscription and this device-s prefs', () => {
    const body = { subscription, prefs: { names: { n: 'A' }, hidden: [], notify: { n: 'discreet' } } };
    expect(PushSubscriptionPut.parse(body)).toEqual(body);
  });

  it('refuses a non-https endpoint or an unknown level', () => {
    const prefs = { names: {}, hidden: [] };
    expect(
      PushSubscriptionPut.safeParse({ subscription: { ...subscription, endpoint: 'http://x/' }, prefs }).success,
    ).toBe(false);
    expect(PushSubscriptionPut.safeParse({ subscription, prefs: { ...prefs, notify: { n: 'loud' } } }).success).toBe(
      false,
    );
  });
});
