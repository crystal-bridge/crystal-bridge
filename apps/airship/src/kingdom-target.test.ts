import { describe, expect, it } from 'vitest';
import { kingdomTarget } from './kingdom-target.js';

describe('kingdomTarget', () => {
  it('follows the packaged hub, and names nothing for a hub run from git', () => {
    expect(kingdomTarget(undefined, '1.2.3')).toBe('1.2.3');
    expect(kingdomTarget('', '1.2.3')).toBe('1.2.3');
    expect(kingdomTarget(undefined, undefined)).toBeUndefined();
  });

  it('takes a version, or off, over its own', () => {
    expect(kingdomTarget('1.3.0', '1.2.3')).toBe('1.3.0');
    expect(kingdomTarget('1.3.0', undefined)).toBe('1.3.0');
    expect(kingdomTarget('off', '1.2.3')).toBeUndefined();
  });

  it('refuses at start rather than naming something a Kingdom would drop', () => {
    expect(() => kingdomTarget('latest', '1.2.3')).toThrow('AIRSHIP_KINGDOM_VERSION');
  });
});
