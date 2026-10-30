import gameIconsJson from '@iconify-json/game-icons/icons.json?raw';
import phJson from '@iconify-json/ph/icons.json?raw';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { drawing, type IconifyPack } from './iconBuild.js';
import { ICON_DATA } from './iconData.js';
import { Icon } from './icons.js';
import { ICON_PACKS, ICON_SOURCES, iconAuthors, type IconPack } from './iconSources.js';

const PACKS: Record<IconPack, IconifyPack> = {
  'game-icons': JSON.parse(gameIconsJson) as IconifyPack,
  ph: JSON.parse(phJson) as IconifyPack,
};

describe('icon build', () => {
  const fake: IconifyPack = {
    width: 24,
    height: 24,
    icons: {
      a: { body: '<path fill="currentColor" d="M0 0h1"/><path fill="currentColor" d="M2 2h1"/>' },
      stroked: { body: '<path fill="none" stroke="currentColor" d="M0 0h1"/>' },
    },
    aliases: { b: { parent: 'a' } },
  };

  it("takes an icon's filled paths and size, through aliases too", () => {
    expect(drawing(fake, { pack: 'ph', icon: 'b' })).toEqual({ viewBox: '0 0 24 24', paths: ['M0 0h1', 'M2 2h1'] });
  });

  it("refuses an icon it can't draw as filled paths, and a missing one", () => {
    expect(() => drawing(fake, { pack: 'ph', icon: 'stroked' })).toThrow('ph/stroked');
    expect(() => drawing(fake, { pack: 'ph', icon: 'nope' })).toThrow('no icon "nope"');
  });

  it('has iconData.ts in step with iconSources.ts (run `pnpm icons` after changing a source)', () => {
    expect(Object.keys(PACKS).sort()).toEqual(Object.keys(ICON_PACKS).sort());
    for (const [name, source] of Object.entries(ICON_SOURCES)) {
      expect(ICON_DATA[name as keyof typeof ICON_DATA], name).toEqual(drawing(PACKS[source.pack], source));
    }
    expect(Object.keys(ICON_DATA).sort()).toEqual(Object.keys(ICON_SOURCES).sort());
  });

  it('credits every Game-icons artist used', () => {
    expect(iconAuthors('game-icons')).toEqual([
      'Carl Olsen',
      'Caro Asercion',
      'Delapouite',
      'Lorc',
      'Lucas',
      'Sbed',
      'Skoll',
    ]);
    expect(iconAuthors('ph')).toEqual([]);
  });
});

describe('Icon', () => {
  it("draws the icon's paths in its own colour class, hidden from screen readers", () => {
    const { container } = render(<Icon name="items" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe(ICON_DATA.items.viewBox);
    expect(svg.getAttribute('class')).toBe('cb-icon cb-icon-items');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.querySelectorAll('path')).toHaveLength(ICON_DATA.items.paths.length);
  });

  it('takes a size', () => {
    const { container } = render(<Icon name="send" size={20} />);
    expect(container.querySelector('svg')!.getAttribute('width')).toBe('20');
  });
});
