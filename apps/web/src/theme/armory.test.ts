import { describe, expect, it } from 'vitest';
import { ARMORY, armoryIcons, familyOf, iconForName } from './armory.js';
import { ICON_SOURCES } from './iconSources.js';

describe('the Armory', () => {
  it('is a small curated set of the pack-s icons, with no repeats', () => {
    const icons = armoryIcons();
    expect(icons).toHaveLength(42);
    expect(new Set(icons).size).toBe(icons.length);
    for (const icon of icons) expect(ICON_SOURCES[icon].pack).toBe('game-icons');
  });

  it('tells which family an icon is in, for its colour', () => {
    expect(familyOf('rocket')).toBe('voyage');
    expect(familyOf('spells')).toBeUndefined();
    expect(ARMORY.map((family) => family.id)).toContain('forge');
  });
});

describe('iconForName', () => {
  it.each([
    ['deploy', 'rocket'],
    ['test-driven-development', 'bubblingFlask'],
    ['systematic-debugging', 'bugNet'],
    ['code-review', 'magnifyingGlass'],
    ['compact', 'magicPotion'],
    ['write-docs', 'quillInk'],
  ])('gives %s a sensible icon', (name, icon) => {
    expect(iconForName(name)).toBe(icon);
  });

  it('checks specific rules first: security-review is about security', () => {
    expect(iconForName('security-review')).toBe('padlock');
  });

  it('ignores case', () => {
    expect(iconForName('Deploy')).toBe('rocket');
  });

  it('matches nothing for a name it can-t place', () => {
    expect(iconForName('zzz')).toBeUndefined();
  });

  it('only suggests icons from the Armory', () => {
    const names = ['deploy', 'test', 'bug', 'review', 'plan', 'design', 'secret', 'doc', 'pdf', 'search', 'git'];
    for (const name of names) expect(armoryIcons()).toContain(iconForName(name));
  });
});
