import { describe, expect, it, vi } from 'vitest';
import { cachedCliVersion, parseCliVersion } from './cli-version.js';

describe('parseCliVersion', () => {
  it('takes the version from what the CLI prints', () => {
    expect(parseCliVersion('2.1.314 (Claude Code)\n')).toBe('2.1.314');
  });

  it('is nothing for anything else', () => {
    expect(parseCliVersion('command not found')).toBeUndefined();
  });
});

describe('cachedCliVersion', () => {
  it('runs the CLI once within the period, and again after it', async () => {
    let time = 0;
    const exec = vi.fn(async () => '2.1.314 (Claude Code)');
    const version = cachedCliVersion({ exec, now: () => time, ttlMs: 1000 });
    expect(await version()).toBe('2.1.314');
    expect(await version()).toBe('2.1.314');
    expect(exec).toHaveBeenCalledTimes(1);
    time = 1001;
    await version();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('is nothing when the CLI cannot run', async () => {
    const version = cachedCliVersion({
      exec: async () => {
        throw new Error('ENOENT');
      },
    });
    expect(await version()).toBeUndefined();
  });
});
