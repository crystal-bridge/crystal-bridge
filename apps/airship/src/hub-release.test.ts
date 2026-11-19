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

  it('on edge, takes the newest release of all, pre-releases included, and skips drafts and non-versions', async () => {
    const list = [
      { tag_name: 'v0.6.0', html_url: 'https://example.invalid/0.6.0', body: '' },
      { tag_name: 'v0.6.1-edge.3', html_url: 'https://example.invalid/e3', body: 'third', prerelease: true },
      { tag_name: 'v0.6.1-edge.10', html_url: 'https://example.invalid/e10', body: 'tenth', prerelease: true },
      { tag_name: 'v0.6.1-edge.11', draft: true },
      { tag_name: 'nightly' },
    ];
    const fetchList = vi.fn(async (_url: string) => answer(list));
    const check = latestReleaseChecker({ fetch: fetchList, now: () => 0, channel: () => 'edge' });
    expect(await check()).toEqual({ version: '0.6.1-edge.10', url: 'https://example.invalid/e10', notes: 'tenth' });
    expect(vi.mocked(fetchList).mock.calls[0]![0]).toBe(
      'https://api.github.com/repos/crystal-bridge/crystal-bridge/releases?per_page=30',
    );
  });

  it('asks again at once when the channel changes', async () => {
    let channel: 'stable' | 'edge' = 'stable';
    const fetchAny = vi.fn(async (url: string) =>
      url.endsWith('/latest') ? answer(release) : answer([{ ...release, tag_name: 'v1.2.1-edge.1' }]),
    );
    const check = latestReleaseChecker({ fetch: fetchAny, now: () => 0, ttlMs: 60_000, channel: () => channel });
    expect((await check())?.version).toBe('1.2.0');
    channel = 'edge';
    expect((await check())?.version).toBe('1.2.1-edge.1');
  });
});
