import { describe, expect, it } from 'vitest';
import { CLASSIC, CRYSTAL, hint, stepWord, useLine, w, castLine, summonLine } from './words.js';

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

describe('the Inventory words', () => {
  it('names the Belt, Equipment, Runes and Guild in both themes, with the plain term as the hint', () => {
    expect(hint('belt', CRYSTAL)).toBe('Belt (pinned actions)');
    expect(hint('gear', CRYSTAL)).toBe('Equipment (plugins)');
    expect(hint('guild', CRYSTAL)).toBe('Guild (agents)');
    expect(hint('runes', CRYSTAL)).toBe('Runes (MCP servers)');
    expect(w('belt', CLASSIC)).toBe('Pinned');
    expect(w('gear', CLASSIC)).toBe('Plugins');
    expect(w('guild', CLASSIC)).toBe('Agents');
    expect(w('runes', CLASSIC)).toBe('MCP servers');
  });
});

describe('useLine', () => {
  it('names the Hero and what it used, with a verb per Inventory category', () => {
    expect(useLine('spells', 'Paladin', 'deploy', CRYSTAL)).toEqual({
      themed: 'Paladin casts deploy!',
      plain: 'Used skill: deploy',
    });
    expect(useLine('items', 'Rogue', '/compact', CRYSTAL).themed).toBe('Rogue uses /compact!');
    expect(useLine('runes', 'Sage', 'github', CRYSTAL).themed).toBe('Sage invokes github!');
  });

  it('reads plainly in the Classic theme', () => {
    expect(useLine('spells', 'Paladin', 'deploy', CLASSIC).themed).toBe('Used skill: deploy');
  });

  it('tells a Cast like a game line, and plainly in the hint', () => {
    const cast = { name: 'Video Upscaler', state: 'running' as const };
    const progress = { done: 12, total: 50 };
    expect(castLine({ ...cast, progress }, 'Shiva', CRYSTAL)).toEqual({
      themed: 'Shiva is casting Video Upscaler! 12/50',
      plain: 'Running 12/50',
    });
    expect(castLine({ ...cast, queued: true }, 'Shiva', CRYSTAL).themed).toBe(
      'Video Upscaler awaits its turn on Shiva',
    );
    expect(castLine({ ...cast, state: 'succeeded' }, 'Shiva', CRYSTAL).themed).toBe('Video Upscaler landed!');
    expect(castLine({ ...cast, state: 'failed', exitCode: 3 }, 'Shiva', CRYSTAL)).toEqual({
      themed: 'Video Upscaler fizzled! (3)',
      plain: 'Failed with exit code 3',
    });
    expect(castLine({ ...cast, state: 'cancelled' }, 'Shiva', CRYSTAL).themed).toBe('Video Upscaler was dispelled!');
    expect(castLine({ ...cast, state: 'lost' }, 'Shiva', CRYSTAL)).toEqual({
      themed: 'Shiva vanished!',
      plain: 'Lost: the job is gone and has no result',
    });
  });

  it('keeps Classic’s Cast lines plain', () => {
    expect(castLine({ name: 'encode', state: 'succeeded' }, 'render', CLASSIC).themed).toBe(
      'encode on render: Finished',
    );
    expect(summonLine('render', CRYSTAL)).toEqual({ themed: 'You summoned render!', plain: 'Started a job on render' });
    expect(summonLine('render', CLASSIC).themed).toBe('Started a job on render');
  });
});
