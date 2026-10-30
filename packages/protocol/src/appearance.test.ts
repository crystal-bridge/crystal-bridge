import { describe, expect, it } from 'vitest';
import { Appearance, HubToClient } from './index.js';

describe('Appearance', () => {
  it('accepts each Kingdom-s icon and colour and a tab style, all optional', () => {
    expect(Appearance.safeParse({}).success).toBe(true);
    const full = { looks: { n: { icon: 'castle', colour: '#3550c8' }, m: { icon: 'ship' } }, tabStyle: 'tinted' };
    expect(Appearance.parse(full)).toEqual(full);
  });

  it('refuses colours that are not #rrggbb and oversized values', () => {
    expect(Appearance.safeParse({ looks: { n: { colour: 'red; background:url(x)' } } }).success).toBe(false);
    expect(Appearance.safeParse({ looks: { n: { icon: 'x'.repeat(100) } } }).success).toBe(false);
    expect(Appearance.safeParse({ tabStyle: 'x'.repeat(100) }).success).toBe(false);
  });

  it('travels to clients as an appearance frame', () => {
    expect(HubToClient.safeParse({ kind: 'appearance', appearance: { tabStyle: 'pennant' } }).success).toBe(true);
  });
});
