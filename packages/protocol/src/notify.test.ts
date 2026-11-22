import { describe, expect, it } from 'vitest';
import { Attention } from './commands.js';
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

  it('says a job finished or failed, and a Discreet Kingdom keeps its name out', () => {
    const cast: Attention = {
      kind: 'attention',
      node: 'n',
      session: '00000000-0000-4000-8000-000000000000',
      label: 'Upscale',
      reason: 'cast-failed',
      detail: 'encode on render',
    };
    expect(notificationFor(cast, 'Forge', 'full')).toEqual({
      title: 'Forge had a job fail',
      body: 'Upscale: encode on render',
    });
    expect(notificationFor({ ...cast, reason: 'cast-done' }, 'Forge', 'discreet')).toEqual({
      title: 'Forge finished a job',
      body: 'Open Crystal Bridge to see it.',
    });
  });
});

describe('a Quest that named itself (#287)', () => {
  const titled = { ...base, label: 'The Siege', plainLabel: 'Fix the test', reason: 'done' as const };

  it('names it in plain words to a device on the Classic theme, and in the theme’s words otherwise', () => {
    expect(pushNotificationFor(titled, { names: {}, hidden: [], plainTitles: true })?.body).toBe('Fix the test');
    expect(pushNotificationFor(titled, { names: {}, hidden: [] })?.body).toBe('The Siege');
  });
});

describe('a turn that left Errands (#288)', () => {
  const done = { ...base, reason: 'done' as const, label: 'The Siege', detail: 'Fixed the flaky step.' };

  it('says so after the summary', () => {
    expect(notificationFor({ ...done, errands: 2 }, 'Emberhold', 'full')?.body).toBe(
      'The Siege: Fixed the flaky step, and left you 2 Errands.',
    );
    expect(
      notificationFor({ ...base, reason: 'done', label: 'The Siege', errands: 2 }, 'Emberhold', 'full')?.body,
    ).toBe('The Siege, and left you 2 Errands.');
    expect(notificationFor({ ...done, errands: 1 }, 'Emberhold', 'full')?.body).toBe(
      'The Siege: Fixed the flaky step, and left you an Errand.',
    );
  });

  it('says follow-ups to a Classic device', () => {
    const attention = { ...done, errands: 2 };
    expect(pushNotificationFor(attention, { names: {}, hidden: [], plainTitles: true })?.body).toMatch(
      /and left you 2 follow-ups\.$/,
    );
    expect(notificationFor(attention, 'Emberhold', 'full', true)?.body).toMatch(/and left you 2 follow-ups\.$/);
    expect(notificationFor({ ...done, errands: 1 }, 'Emberhold', 'full', true)?.body).toMatch(
      /and left you a follow-up\.$/,
    );
  });

  it('says nothing about Errands at Discreet, or for a failure', () => {
    expect(notificationFor({ ...done, errands: 2 }, 'Emberhold', 'discreet')?.body).toBe(
      'Open Crystal Bridge to see it.',
    );
    expect(notificationFor({ ...base, reason: 'failed', errands: 2 }, 'Emberhold', 'full')?.body).toBe(base.label);
  });

  it('parses on an Attention, and refuses zero', () => {
    const frame = { kind: 'attention', node: 'n', session: crypto.randomUUID(), label: 'x', reason: 'done' };
    expect(Attention.safeParse({ ...frame, errands: 2 }).success).toBe(true);
    expect(Attention.safeParse({ ...frame, errands: 0 }).success).toBe(false);
  });
});
