import { describe, expect, it } from 'vitest';
import { isOutdated } from './release.js';

describe('isOutdated', () => {
  it('is true only when the hub serves a different release than this page was built from', () => {
    expect(isOutdated('abc123', 'def456')).toBe(true);
    expect(isOutdated('abc123', 'abc123')).toBe(false);
    expect(isOutdated('abc123', undefined)).toBe(false);
  });

  it('never nags a development build or a development hub', () => {
    expect(isOutdated('dev', 'abc123')).toBe(false);
    expect(isOutdated('abc123', 'dev')).toBe(false);
  });
});
