import { describe, expect, it } from 'vitest';
import { CLASSIC, CRYSTAL, hint, stepWord, useLine, w } from './words.js';

describe('theme words', () => {
  it('gives the themed word, and a hint with the plain term when they differ', () => {
    expect(w('quest', CRYSTAL)).toBe('Quest');
    expect(hint('quest', CRYSTAL)).toBe('Quest (session)');
    expect(hint('quest', CLASSIC)).toBe('Session');
  });

  it('calls cost Gold: generic fantasy words, not one franchise’s coinage', () => {
    expect(w('gold', CRYSTAL)).toBe('Gold');
    expect(hint('gold', CRYSTAL)).toBe('Gold (cost)');
    expect(JSON.stringify([CRYSTAL, CLASSIC])).not.toMatch(/\bgil\b/i);
  });

  it('defines every concept in every theme, so a swap never leaves a label blank', () => {
    for (const theme of [CRYSTAL, CLASSIC]) {
      expect(Object.keys(theme).sort()).toEqual(Object.keys(CRYSTAL).sort());
      for (const word of Object.values(theme)) expect(word.themed.trim()).not.toBe('');
    }
  });

  it('words each kind of step in theme terms, the same word for the same step', () => {
    const word = stepWord('write', 1_234, CRYSTAL);
    expect(['Forging', 'Inscribing']).toContain(word.themed);
    expect(word.plain).toBe('editing files');
    expect(stepWord('write', 1_234, CRYSTAL)).toEqual(word);
    const seen = new Set([0, 1, 2, 3, 4, 5, 6, 7].map((seed) => stepWord('write', seed, CRYSTAL).themed));
    expect(seen.size).toBeGreaterThan(1);
    expect(stepWord('write', 1_234, CLASSIC).themed).toBe('Editing');
  });
});

describe('useLine', () => {
  it('names the Hero and what it used, with a verb per Inventory category', () => {
    expect(useLine('spells', 'Paladin', 'deploy', CRYSTAL)).toEqual({
      themed: 'Paladin casts deploy!',
      plain: 'Used skill: deploy',
    });
    expect(useLine('items', 'Rogue', '/compact', CRYSTAL).themed).toBe('Rogue uses /compact!');
    expect(useLine('equipment', 'Sage', 'github', CRYSTAL).themed).toBe('Sage wields github!');
  });

  it('reads plainly in the Classic theme', () => {
    expect(useLine('spells', 'Paladin', 'deploy', CLASSIC).themed).toBe('Used skill: deploy');
  });
});
