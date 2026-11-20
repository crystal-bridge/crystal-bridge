import { describe, expect, it } from 'vitest';
import {
  CLASSIC,
  CRYSTAL,
  helperLine,
  hint,
  stepWord,
  toolChip,
  useLine,
  w,
  castLine,
  summonLine,
  postingsLine,
  scoutReturnLine,
  sourceLine,
  patrolOutcomeWord,
  patrolStandingWord,
} from './words.js';

describe('theme words', () => {
  it('gives the themed word, and a hint with the plain term when they differ', () => {
    expect(w('quest', CRYSTAL)).toBe('Quest');
    expect(hint('quest', CRYSTAL)).toBe('Quest (session)');
    expect(hint('quest', CLASSIC)).toBe('Session');
  });

  it('names the Tavern for what needs you and what finished, not only what waits', () => {
    expect(hint('tavern', CRYSTAL)).toBe('Tavern (What needs you, and what finished since you looked)');
    expect(w('tavern', CLASSIC)).toBe('For you');
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

describe('toolChip', () => {
  it('follows the Class doing the work while running', () => {
    expect(toolChip('running', 'spellcast', CRYSTAL)).toEqual({ themed: 'Casting', plain: 'running' });
    expect(toolChip('running', 'slash', CRYSTAL)).toEqual({ themed: 'Attacking', plain: 'running' });
    expect(toolChip('running', 'shoot', CRYSTAL).themed).toBe('Attacking');
  });

  it('ends in Success, Miss or Blocked, with the plain word as the hint', () => {
    expect(toolChip('done', undefined, CRYSTAL)).toEqual({ themed: 'Success', plain: 'done' });
    expect(toolChip('error', undefined, CRYSTAL)).toEqual({ themed: 'Miss', plain: 'failed' });
    expect(toolChip('denied', undefined, CRYSTAL)).toEqual({ themed: 'Blocked', plain: 'denied' });
  });

  it('stays plain in the Classic theme', () => {
    expect(toolChip('running', 'spellcast', CLASSIC).themed).toBe('running');
    expect(toolChip('error', undefined, CLASSIC).themed).toBe('failed');
  });
});

describe('helperLine', () => {
  it('reads like a game, with the plain form as the hint', () => {
    expect(helperLine('set-out', 'Wizard', 'Security review', CRYSTAL)).toEqual({
      themed: 'Wizard sets out: Security review!',
      plain: 'Started a subagent: Security review',
    });
    expect(helperLine('returned', 'Wizard', 'Security review', CRYSTAL).themed).toBe(
      'Wizard returns from Security review!',
    );
    expect(helperLine('stopped', 'Wizard', 'Security review', CRYSTAL)).toEqual({
      themed: 'Wizard was KO’d on Security review!',
      plain: 'Subagent stopped: Security review',
    });
  });

  it('is plain in the Classic theme', () => {
    expect(helperLine('failed', 'Wizard', 'Security review', CLASSIC).themed).toBe('Subagent failed: Security review');
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

  // A word typed into a label stays themed in the Classic build, where `w()` would give the plain one.
  it('keeps theme words out of the labels components hard-code', () => {
    const sources = import.meta.glob<string>(['../components/*.tsx', '!../components/*.test.tsx'], {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    expect(Object.keys(sources).length).toBeGreaterThan(0);
    for (const [file, source] of Object.entries(sources)) {
      expect(source, file).not.toMatch(/label="(Kingdom|Quest|Party|Hero)"/);
    }
  });
});

describe('Scout and Board words', () => {
  it('names Scouts and Boards, and Classic never reuses its word for a Cast', () => {
    expect(hint('scout', CRYSTAL)).toBe('Scout (a scheduled job that collects items)');
    expect(w('board', CRYSTAL)).toBe('Board');
    expect(w('scouts', CLASSIC)).toBe('Scheduled jobs');
    expect(w('scouts', CLASSIC)).not.toBe(w('casts', CLASSIC));
  });

  it('tells what a Scout brought back as a game line, with the plain words as the hint', () => {
    expect(scoutReturnLine(4, CRYSTAL)).toEqual({
      themed: 'Your Scout returned with 4 findings.',
      plain: 'Found 4 items',
    });
    expect(scoutReturnLine(1, CRYSTAL).themed).toBe('Your Scout returned with 1 finding.');
    expect(scoutReturnLine(0, CRYSTAL).themed).toBe('Your Scout returned empty-handed.');
    expect(scoutReturnLine(4, CLASSIC).themed).toBe('Found 4 items');
  });

  it('keeps step words clear of Scout, which means a scheduled job', () => {
    const read = [0, 1, 2, 3].map((seed) => stepWord('read', seed, CRYSTAL).themed);
    expect(read.some((word) => /scout/i.test(word))).toBe(false);
  });

  it('says where an item-s rank and summary came from, naming the synthesis step by its word', () => {
    const step = 'synthesis';
    expect(sourceLine({ rank: 2, rankSource: step, summary: 's', summarySource: step }, CRYSTAL)).toBe(
      'Rank 2 · rank and summary from Augury (the synthesis step)',
    );
    expect(sourceLine({ rank: 2, rankSource: step, summary: 's', summarySource: step }, CLASSIC)).toBe(
      'Rank 2 · rank and summary from the synthesis step',
    );
    expect(sourceLine({ rank: 3, summary: 's', summarySource: step }, CLASSIC)).toBe(
      'Rank 3, from the collector · summary from the synthesis step',
    );
    expect(sourceLine({ rank: 1 }, CRYSTAL)).toBe('Rank 1, from the collector');
    expect(sourceLine({ summary: '', summarySource: step }, CLASSIC)).toBeUndefined();
    expect(sourceLine({ summary: '', summarySource: step, whole: true }, CRYSTAL)).toBe(
      'Written by Augury (the synthesis step)',
    );
    expect(sourceLine({ rank: 5, rankSource: step, summarySource: step, whole: true }, CLASSIC)).toBe(
      'Rank 5 · written by the synthesis step',
    );
    expect(sourceLine({ summary: 's', summarySource: 'triage' }, CLASSIC)).toBe('Summary from "triage"');
    expect(sourceLine({}, CRYSTAL)).toBeUndefined();
  });

  it('counts new postings on a Board', () => {
    expect(postingsLine(3, 'Quest Board', CRYSTAL)).toEqual({
      themed: '3 new postings on the Quest Board.',
      plain: '3 new on Quest Board',
    });
    expect(postingsLine(1, 'Mail', CRYSTAL).themed).toBe('1 new posting on the Mail Board.');
    expect(postingsLine(3, 'Quest Board', CLASSIC).themed).toBe('3 new on Quest Board');
  });
});

describe('Patrol words', () => {
  it('names the Watchtower in each theme, with Classic’s everyday words', () => {
    expect(w('watchtower', CRYSTAL)).toBe('Watchtower');
    expect(w('watchtower', CLASSIC)).toBe('Scheduled tasks');
    expect(w('patrol', CLASSIC)).toBe('Scheduled task');
    expect(w('nextRun', CRYSTAL)).toBe('Next watch');
    expect(w('nextRun', CLASSIC)).toBe('Next run');
  });

  it('says how a run ended as the issue’s run words, plainly in Classic, and keeps an unknown outcome', () => {
    expect(patrolOutcomeWord('running', CRYSTAL)).toEqual({ themed: 'Set out', plain: 'Running' });
    expect(patrolOutcomeWord('finished', CRYSTAL).themed).toBe('Returned');
    expect(patrolOutcomeWord('failed', CRYSTAL).themed).toBe('Turned back');
    expect(patrolOutcomeWord('skipped', CRYSTAL)).toEqual({
      themed: 'Still out',
      plain: 'Skipped: the last run was still out',
    });
    expect(patrolOutcomeWord('failed', CLASSIC)).toEqual({ themed: 'Failed', plain: 'Failed' });
    expect(patrolOutcomeWord('lost-at-sea', CRYSTAL)).toEqual({ themed: 'lost-at-sea', plain: 'lost-at-sea' });
  });

  it('says how a Patrol stands: a paused one is stood down', () => {
    expect(patrolStandingWord('stood-down', CRYSTAL).themed).toBe('Stood down');
    expect(patrolStandingWord('stood-down', CLASSIC).themed).toBe('Paused');
    expect(patrolStandingWord('on-watch', CRYSTAL)).toEqual({ themed: 'On watch', plain: 'Scheduled' });
  });
});
