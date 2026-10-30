import { describe, expect, it } from 'vitest';
import { releaseId } from './release.js';

describe('releaseId', () => {
  it('is the version a packaged build carries', () => {
    expect(releaseId('0.2.0', '/home/me/.npm/_npx/abc123/node_modules/@crystal-bridge/kingdom')).toBe('0.2.0');
  });

  it('is the commit a deploy named its release folder after', () => {
    expect(releaseId(undefined, '/home/me/.local/share/crystal-bridge/releases/38d1f792cd78')).toBe('38d1f792cd78');
  });

  it('is nothing for a checkout', () => {
    expect(releaseId(undefined, '/home/me/code/crystal-bridge')).toBeUndefined();
  });
});
