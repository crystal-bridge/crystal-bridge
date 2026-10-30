import { describe, expect, it } from 'vitest';
import { type HeroManifest, heroAnimation, matchClass, questState } from './heroes.js';
import shippedRaw from '../public/heroes/manifest.json?raw';
import recipesRaw from '../../../tools/sprites/classes.json?raw';

const manifest: HeroManifest = {
  leader: 'paladin',
  fallback: 'wizard',
  classes: {
    paladin: { name: 'Paladin', match: ['security'], work: 'slash', verb: 'Smite', victory: 'emote', anims: {} },
    wizard: {
      name: 'Wizard',
      match: ['general-purpose'],
      work: 'spellcast',
      verb: 'Cast',
      victory: 'spellcast',
      anims: {},
    },
    cleric: {
      name: 'Cleric',
      match: ['review', 'test'],
      work: 'spellcast',
      verb: 'Heal',
      victory: 'spellcast',
      anims: {},
    },
    rogue: { name: 'Rogue', match: ['explore', 'search'], work: 'slash', verb: 'Sneak', victory: 'emote', anims: {} },
  },
};

describe('matchClass', () => {
  it('gives the main agent the leader Class', () => {
    expect(matchClass(manifest, undefined, { leader: true })).toBe('paladin');
  });

  it('matches agent names by keyword, case-insensitively, first Class wins', () => {
    expect(matchClass(manifest, 'Explore')).toBe('rogue');
    expect(matchClass(manifest, 'code-reviewer')).toBe('cleric');
    expect(matchClass(manifest, 'claude-security')).toBe('paladin');
    // "search" and "test" both appear: cleric comes before rogue in the manifest.
    expect(matchClass(manifest, 'test-search')).toBe('cleric');
  });

  it('falls back for unknown or missing agent names', () => {
    expect(matchClass(manifest, 'statusline-setup')).toBe('wizard');
    expect(matchClass(manifest, undefined)).toBe('wizard');
  });
});

describe('questState', () => {
  const now = 1_000_000;
  const base = { status: 'running' as const, waiting: false, lastActivity: now - 1_000, now };

  it('needs you while waiting, whatever else is going on', () => {
    expect(questState({ ...base, waiting: true, outcome: { reason: 'failed', at: now } })).toBe('alert');
  });

  it('works while its process runs and nothing has finished since its latest activity', () => {
    expect(questState(base)).toBe('working');
    expect(questState({ ...base, outcome: { reason: 'done', at: now - 60_000 } })).toBe('working');
  });

  it('cheers for a while after a finished turn, then rests', () => {
    expect(questState({ ...base, outcome: { reason: 'done', at: now - 500 } })).toBe('victory');
    expect(questState({ ...base, lastActivity: now - 600_000, outcome: { reason: 'done', at: now - 590_000 } })).toBe(
      'resting',
    );
  });

  it('is KO after a failure until it has new activity', () => {
    expect(questState({ ...base, outcome: { reason: 'failed', at: now - 500 } })).toBe('ko');
    expect(questState({ ...base, lastActivity: now, outcome: { reason: 'failed', at: now - 60_000 } })).toBe('working');
  });

  it('rests when idle, ended or closed, and when a running process has been quiet for minutes', () => {
    expect(questState({ ...base, status: 'idle' })).toBe('resting');
    expect(questState({ ...base, status: 'ended' })).toBe('resting');
    expect(questState({ ...base, status: 'closed' })).toBe('resting');
    expect(questState({ ...base, lastActivity: now - 5 * 60_000 })).toBe('resting');
  });
});

describe('heroAnimation', () => {
  const cls = {
    ...manifest.classes.paladin!,
    anims: { idle: { frames: 2, size: 64 }, slash: { frames: 6, size: 128 } },
  };

  it('plays the Class-s work animation while working, idle when resting or needing you', () => {
    expect(heroAnimation(cls, 'working')).toMatchObject({ anim: 'slash', loop: true });
    expect(heroAnimation(cls, 'resting')).toMatchObject({ anim: 'idle', loop: true });
    expect(heroAnimation(cls, 'alert')).toMatchObject({ anim: 'idle', bubble: true });
  });

  it('holds the last hurt frame for KO, and a raised cast for Classes without a cheer', () => {
    expect(heroAnimation(cls, 'ko')).toMatchObject({ anim: 'hurt', loop: false });
    expect(heroAnimation(manifest.classes.wizard!, 'victory')).toMatchObject({
      anim: 'spellcast',
      hold: 3,
      sparkle: true,
    });
    expect(heroAnimation(cls, 'victory')).toMatchObject({ anim: 'emote', loop: false });
  });

  it('ships D&D-style Classes, in the app and in the sprite recipes', () => {
    const shipped = JSON.parse(shippedRaw);
    const recipes = JSON.parse(recipesRaw);
    for (const pack of [shipped, recipes]) {
      expect(pack.fallback).toBe('wizard');
      const names = Object.entries(pack.classes).map(([id, cls]) => `${id}:${(cls as { name: string }).name}`);
      expect(names.sort()).toEqual(
        ['cleric:Cleric', 'paladin:Paladin', 'ranger:Ranger', 'rogue:Rogue', 'sage:Sage', 'wizard:Wizard'].sort(),
      );
      expect(JSON.stringify(pack)).not.toMatch(/black ?mage|white ?mage|black magic|thief|"Cure"|"Steal"/i);
    }
  });
});
