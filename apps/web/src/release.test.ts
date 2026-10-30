import { describe, expect, it } from 'vitest';
import { isBehind, isOutdated, releaseLabel } from './release.js';

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

describe('releaseLabel', () => {
  it('shortens a commit', () => {
    expect(releaseLabel('0123456789ab')).toBe('0123456');
  });

  it('keeps a version whole', () => {
    expect(releaseLabel('0.2.0-alpha.1')).toBe('0.2.0-alpha.1');
  });
});

describe('isBehind', () => {
  it('compares versions as numbers', () => {
    expect(isBehind('0.2.0', '0.3.0')).toBe(true);
    expect(isBehind('0.9.0', '0.10.0')).toBe(true);
    expect(isBehind('0.3.0', '0.3.0')).toBe(false);
    expect(isBehind('0.4.0', '0.3.0')).toBe(false);
  });

  it('puts a pre-release before its release, and in order among others', () => {
    expect(isBehind('0.2.0-alpha.0', '0.2.0')).toBe(true);
    expect(isBehind('0.2.0', '0.2.0-alpha.0')).toBe(false);
    expect(isBehind('0.2.0-alpha.2', '0.2.0-alpha.10')).toBe(true);
    expect(isBehind('0.2.0-alpha.1', '0.2.0-alpha.1')).toBe(false);
  });

  it('never guesses about a commit, a dev build or a missing release', () => {
    expect(isBehind('0123456789ab', '0.3.0')).toBe(false);
    expect(isBehind('0.2.0', '0123456789ab')).toBe(false);
    expect(isBehind('0.2.0', 'dev')).toBe(false);
    expect(isBehind(undefined, '0.3.0')).toBe(false);
    expect(isBehind('0.2.0', undefined)).toBe(false);
  });
});
