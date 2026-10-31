import { describe, expect, it, vi } from 'vitest';
import { latestReleaseChecker } from './hub-release.js';

const answer = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
const release = { tag_name: 'v1.2.0', html_url: 'https://example.invalid/r', body: 'What changed' };

describe('latestReleaseChecker', () => {
  it('returns the latest release, and asks only once within the period', async () => {
    const fetchLatest = vi.fn(async () => answer(release));
    const check = latestReleaseChecker({ fetch: fetchLatest, now: () => 0, ttlMs: 1000 });
    const expected = { version: '1.2.0', url: 'https://example.invalid/r', notes: 'What changed' };
    expect(await check()).toEqual(expected);
    expect(await check()).toEqual(expected);
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchLatest).mock.calls[0]).toEqual([
      'https://api.github.com/repos/crystal-bridge/crystal-bridge/releases/latest',
      expect.objectContaining({ headers: expect.objectContaining({ 'user-agent': 'crystal-bridge-airship' }) }),
    ]);
  });

  it('keeps the last good answer when GitHub fails, or says something that is not a version', async () => {
    let time = 0;
    const answers = [
      async () => answer(release),
      async () => {
        throw new Error('offline');
      },
      async () => answer({ tag_name: 'nightly' }),
      async () => answer({}, false),
    ];
    const check = latestReleaseChecker({ fetch: () => answers[time]!(), now: () => time * 2000, ttlMs: 1000 });
    expect((await check())?.version).toBe('1.2.0');
    for (time = 1; time < answers.length; time++) expect((await check())?.version).toBe('1.2.0');
  });

  it('copes with a release that has no notes, and cuts long ones short', async () => {
    const check = latestReleaseChecker({ fetch: async () => answer({ tag_name: 'v1.2.0' }), now: () => 0 });
    expect((await check())?.notes).toBe('');
    const long = latestReleaseChecker({
      fetch: async () => answer({ ...release, body: 'x'.repeat(20_000) }),
      now: () => 0,
    });
    expect((await long())?.notes.length).toBeLessThanOrEqual(4001);
  });

  it('sticks to an https link, since the page shows it', async () => {
    const check = latestReleaseChecker({
      fetch: async () => answer({ ...release, html_url: 'javascript:alert(1)' }),
      now: () => 0,
    });
    expect((await check())?.url).toBe('https://github.com/crystal-bridge/crystal-bridge/releases/tag/v1.2.0');
  });
});
