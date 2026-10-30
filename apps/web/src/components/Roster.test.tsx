import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { HeroManifest } from '../heroes.js';
import { levelFor } from '../levels.js';
import { Roster } from './Roster.js';

const manifest: HeroManifest = {
  leader: 'paladin',
  fallback: 'paladin',
  classes: {
    paladin: { name: 'Paladin', match: [], work: 'slash', verb: 'Smite', victory: 'emote', anims: {} },
    rogue: { name: 'Rogue', match: [], work: 'slash', verb: 'Sneak', victory: 'emote', anims: {} },
    sage: { name: 'Sage', match: [], work: 'spellcast', verb: 'Scan', victory: 'spellcast', anims: {} },
  },
};

describe('Roster', () => {
  afterEach(() => cleanup());

  it('lists every Class, highest level first, with its progress to the next', () => {
    render(<Roster manifest={manifest} levels={{ paladin: levelFor(450), rogue: levelFor(120) }} />);
    const roster = screen.getByRole('region', { name: 'Roster' });
    const rows = within(roster).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('PaladinLv 3'),
      expect.stringContaining('RogueLv 2'),
      expect.stringContaining('SageLv 1'),
    ]);
    const bar = within(rows[0]!).getByRole('meter', { name: 'Paladin XP to the next level' });
    expect(bar.getAttribute('aria-valuenow')).toBe('150');
    expect(bar.getAttribute('aria-valuemax')).toBe('300');
  });
});
