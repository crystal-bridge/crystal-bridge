import { describe, expect, it, vi } from 'vitest';
import { latestCliChecker } from './cli-release.js';

const answer = (version: unknown, ok = true) => ({ ok, json: async () => ({ version }) }) as Response;

describe('latestCliChecker', () => {
  it('returns the published version, and asks only once within the period', async () => {
    const fetchLatest = vi.fn(async () => answer('2.1.320'));
    const check = latestCliChecker({ fetch: fetchLatest, now: () => 0, ttlMs: 1000 });
    expect(await check()).toBe('2.1.320');
    expect(await check()).toBe('2.1.320');
    expect(fetchLatest).toHaveBeenCalledTimes(1);
  });

  it('asks again after the period', async () => {
    let time = 0;
    const fetchLatest = vi.fn(async () => answer(time === 0 ? '2.1.320' : '2.1.321'));
    const check = latestCliChecker({ fetch: fetchLatest, now: () => time, ttlMs: 1000 });
    await check();
    time = 1001;
    expect(await check()).toBe('2.1.321');
  });

  it('keeps the last good answer when the registry fails or says nonsense', async () => {
    let time = 0;
    const replies = [
      async () => answer('2.1.320'),
      async () => {
        throw new Error('offline');
      },
      async () => answer('2.1.999', false),
      async () => answer(42),
    ];
    const fetchLatest = vi.fn(() => replies.shift()!());
    const check = latestCliChecker({ fetch: fetchLatest, now: () => time, ttlMs: 1000 });
    for (const step of [0, 2000, 4000, 6000]) {
      time = step;
      expect(await check()).toBe('2.1.320');
    }
  });

  it('is empty, not an error, before any answer has come', async () => {
    const check = latestCliChecker({
      fetch: async () => {
        throw new Error('offline');
      },
    });
    await expect(check()).resolves.toBeUndefined();
  });
});
