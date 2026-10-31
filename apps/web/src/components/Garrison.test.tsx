import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { HeroManifest } from '../heroes.js';
import { levelFor } from '../levels.js';
import { Garrison } from './Garrison.js';

const cls = (name: string) => ({ name, keywords: [], animations: {} });
const manifest = {
  leader: 'paladin',
  classes: { paladin: cls('Paladin'), mage: cls('Mage'), rogue: cls('Rogue'), wizard: cls('Wizard') },
} as unknown as HeroManifest;

const names = () =>
  within(screen.getByRole('region', { name: 'Garrison' }))
    .getAllByRole('listitem')
    .map((row) => row.textContent);

describe('Garrison', () => {
  afterEach(() => cleanup());

  it('lists the Heroes who have been here, highest first', () => {
    render(<Garrison manifest={manifest} levels={{ mage: levelFor(100), rogue: levelFor(350) }} />);
    expect(names()).toEqual([expect.stringMatching(/^Rogue.*Lv 3/), expect.stringMatching(/^Mage.*Lv 2/)]);
  });

  it('puts the Kingdom’s leader at the head of the line, marked', () => {
    render(<Garrison manifest={manifest} leader="mage" levels={{ mage: levelFor(100), rogue: levelFor(350) }} />);
    expect(names()[0]).toMatch(/^Mage.*Leader/);
    expect(names()[1]).not.toMatch(/Leader/);
  });

  it('adds no stranger for a leader who has no XP here', () => {
    render(<Garrison manifest={manifest} leader="wizard" levels={{ rogue: levelFor(350) }} />);
    expect(names()).toEqual([expect.stringMatching(/^Rogue/)]);
  });

  it('says so when nobody has been here, instead of showing a row of level-1 strangers', () => {
    render(<Garrison manifest={manifest} levels={{}} />);
    expect(within(screen.getByRole('region', { name: 'Garrison' })).queryByRole('list')).toBeNull();
    expect(screen.getByText(/Heroes join/)).toBeDefined();
  });

  it('skips a Class the art pack no longer has', () => {
    render(<Garrison manifest={manifest} levels={{ gone: levelFor(5000), mage: levelFor(100) }} />);
    expect(names()).toEqual([expect.stringMatching(/^Mage/)]);
  });
});
