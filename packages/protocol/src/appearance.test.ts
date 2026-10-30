import { describe, expect, it } from 'vitest';
import { Appearance, HubToClient } from './index.js';

describe('Appearance', () => {
  it('accepts each Kingdom-s icon and colour and a tab style, all optional', () => {
    expect(Appearance.safeParse({}).success).toBe(true);
    const full = { looks: { n: { icon: 'castle', colour: '#3550c8' }, m: { icon: 'ship' } }, tabStyle: 'tinted' };
    expect(Appearance.parse(full)).toEqual(full);
  });

  it("keeps each Kingdom's party leader choice (a Class id, or varied)", () => {
    const leaders = { looks: { n: { leader: 'rogue' }, m: { leader: 'varied' } } };
    expect(Appearance.parse(leaders)).toEqual(leaders);
    expect(Appearance.safeParse({ looks: { n: { leader: 'x'.repeat(100) } } }).success).toBe(false);
  });

  it('refuses colours that are not #rrggbb and oversized values', () => {
    expect(Appearance.safeParse({ looks: { n: { colour: 'red; background:url(x)' } } }).success).toBe(false);
    expect(Appearance.safeParse({ looks: { n: { icon: 'x'.repeat(100) } } }).success).toBe(false);
    expect(Appearance.safeParse({ tabStyle: 'x'.repeat(100) }).success).toBe(false);
  });

  it("keeps each Kingdom's Belt: slots or gaps, at most eight", () => {
    const slot = {
      label: 'deploy',
      text: '/deploy ',
      icon: 'rocket',
      now: true,
      source: { category: 'spells', name: 'deploy' },
    };
    const belts = { belts: { n: [slot, null, { label: 'Go on', text: 'Continue.' }] } };
    expect(Appearance.parse(belts)).toEqual(belts);
    expect(Appearance.safeParse({ belts: { n: Array(9).fill(null) } }).success).toBe(false);
    expect(Appearance.safeParse({ belts: { n: [{ label: 'x', text: 'x'.repeat(5000) }] } }).success).toBe(false);
  });

  it('travels to clients as an appearance frame', () => {
    expect(HubToClient.safeParse({ kind: 'appearance', appearance: { tabStyle: 'pennant' } }).success).toBe(true);
  });
});
