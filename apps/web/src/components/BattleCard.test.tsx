import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { BattleResult } from '../battle.js';
import type { HeroManifest } from '../heroes.js';
import { BattleCard } from './BattleCard.js';

const turn: BattleResult = {
  outcome: 'victory',
  turns: 1,
  durationMs: 4000,
  costUsd: 0.25,
  tokens: { input: 1200, output: 300, cacheRead: 50_000, cacheWrite: 0 },
  loot: ['src/a.ts', 'b.md'],
  prs: [],
  heroes: [{ id: 'a1', agentType: 'Explore', description: 'Map the repo' }],
  sideQuests: 1,
};

const manifest: HeroManifest = {
  leader: 'paladin',
  fallback: 'wizard',
  classes: {
    paladin: { name: 'Paladin', match: ['security'], work: 'slash', verb: 'Smite', victory: 'emote', anims: {} },
    wizard: { name: 'Wizard', match: [], work: 'spellcast', verb: 'Cast', victory: 'spellcast', anims: {} },
    cleric: { name: 'Cleric', match: ['review'], work: 'spellcast', verb: 'Heal', victory: 'spellcast', anims: {} },
  },
};

describe('BattleCard', () => {
  afterEach(() => cleanup());

  it('gives helpers the Class the Party gives them, and counts helpers who match', () => {
    const heroes = [
      { id: 'a', agentType: 'general-purpose', description: 'Security review' },
      { id: 'b', agentType: 'general-purpose', description: 'Correctness review' },
      { id: 'c', agentType: 'general-purpose', description: 'Style review' },
    ];
    render(<BattleCard result={{ ...turn, heroes }} kind="turn" manifest={manifest} />);
    fireEvent.click(screen.getByText(/Battle won/).closest('summary')!);
    const row = screen.getByText(/Paladin/).closest('dd, div')!.parentElement!;
    expect(row.textContent).toContain('general-purpose(Paladin)');
    expect(row.textContent).toContain('general-purpose(Cleric)×2');
  });

  it('folds a turn result into one line, with the details a click away', () => {
    render(<BattleCard result={turn} kind="turn" />);
    const summary = screen.getByText(/Battle won/).closest('summary')!;
    expect(summary.closest('details')!.open).toBe(false);
    expect(summary.textContent).toContain('4s');
    expect(summary.textContent).toContain('25 Gold');
    expect(summary.textContent).toContain('2 files');
    fireEvent.click(summary);
    expect(screen.getByText('src/a.ts')).toBeTruthy();
    expect(screen.getByText('Explore')).toBeTruthy();
  });

  it('shows the latest turn open, and says the Quest goes on, so it never reads as the end', () => {
    render(<BattleCard result={turn} kind="turn" latest />);
    const card = screen.getByRole('region', { name: 'Battle won' });
    expect(card.querySelector('details')!.open).toBe(true);
    expect(card.textContent).toContain('src/a.ts');
    expect(card.textContent).toContain('The Quest goes on');
    expect(card.textContent).not.toMatch(/Quest complete/);
  });

  it('links the pull requests a turn opened, and leaves the row out when there are none', () => {
    render(<BattleCard result={{ ...turn, prs: ['https://github.com/o/r/pull/12'] }} kind="turn" latest />);
    expect(screen.getByRole('link', { name: '#12' }).getAttribute('href')).toBe('https://github.com/o/r/pull/12');
    cleanup();
    render(<BattleCard result={turn} kind="turn" latest />);
    expect(screen.queryByText('Trophies')).toBeNull();
  });

  it('names a stopped or failed turn', () => {
    render(<BattleCard result={{ ...turn, outcome: 'retreat' }} kind="turn" />);
    expect(screen.getByText(/Retreat/)).toBeTruthy();
    cleanup();
    render(<BattleCard result={{ ...turn, outcome: 'ko' }} kind="turn" />);
    expect(screen.getByText(/KO/)).toBeTruthy();
  });

  it('shows the whole Quest open when it closes, with its totals', () => {
    render(<BattleCard result={{ ...turn, turns: 7, mpUsedPct: 41 }} kind="quest" />);
    const card = screen.getByRole('region', { name: 'Quest complete' });
    expect(within(card).getByTitle(/the Quest is over/)).toBeTruthy();
    expect(card.textContent).toContain('7');
    expect(card.textContent).toContain('41%');
    expect(screen.getByText('src/a.ts')).toBeTruthy();
  });
});
