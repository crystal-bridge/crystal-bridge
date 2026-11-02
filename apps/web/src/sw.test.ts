import { describe, expect, it, vi } from 'vitest';
import SOURCE from '../public/sw.js?raw';

/** Runs the service worker against a stand-in `self`, and delivers one push to it. */
async function push(data: unknown) {
  const listeners = new Map<string, (event: unknown) => void>();
  const showNotification = vi.fn(async () => {});
  const self = {
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    clients: { matchAll: async () => [] },
    registration: { showNotification },
  };
  new Function('self', SOURCE)(self);
  let done: Promise<unknown> = Promise.resolve();
  listeners.get('push')!({
    data: { json: () => data },
    waitUntil: (work: Promise<unknown>) => {
      done = work;
    },
  });
  await done;
  return showNotification;
}

describe('the service worker', () => {
  it('alerts again when a push replaces an unread notification with the same tag', async () => {
    const shown = await push({ title: 'n needs you', body: 'Bash', tag: 'quest', node: 'n', session: 's' });
    expect(shown).toHaveBeenCalledWith('n needs you', expect.objectContaining({ tag: 'quest', renotify: true }));
  });

  it('leaves renotify off without a tag, where a browser refuses it', async () => {
    const shown = await push({ title: 'hello', body: 'there' });
    expect(shown).toHaveBeenCalledWith('hello', expect.objectContaining({ renotify: false }));
  });
});
