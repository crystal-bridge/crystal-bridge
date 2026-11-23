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
  questLabel,
  titledLine,
  errandsLeftLine,
  errandsLeftPhrase,
  errandsWaitLine,
  errandWords,
  postingsLine,
  scoutReturnLine,
  sourceLine,
  patrolOutcomeWord,
  patrolStandingWord,
  deedRecordedLine,
  deedRefusedLine,
  closingLine,
  questStandingWord,
  recordDeedsChoice,
  closingStoppedReason,
  deedsText,
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

describe('Quest titles (#287)', () => {
  it('shows the title a Quest gave itself, in plain words in the Classic theme', () => {
    const quest = { label: 'The Siege of the Flaky Smoke Test', plainLabel: 'Fix the flaky smoke test' };
    expect(questLabel(quest, CRYSTAL)).toBe('The Siege of the Flaky Smoke Test');
    expect(questLabel(quest, CLASSIC)).toBe('Fix the flaky smoke test');
    // A first prompt, or a name set by hand, has no plain form: every theme shows it as it is.
    expect(questLabel({ label: 'fix the smoke test' }, CLASSIC)).toBe('fix the smoke test');
  });

  it('announces the name as the Bard, plainly in Classic', () => {
    expect(titledLine('The Siege', 'Fix the test', CRYSTAL)).toEqual({
      themed: 'The Bard names your Quest: The Siege.',
      plain: 'Named this session: Fix the test',
    });
    expect(titledLine('The Siege', 'Fix the test', CLASSIC).themed).toBe('Named this session: Fix the test');
  });

  it('ends the line on the title’s own stop, and says so when the naming failed', () => {
    expect(titledLine('Why Is CI Red?', 'Find out why CI is red', CRYSTAL).themed).toBe(
      'The Bard names your Quest: Why Is CI Red?',
    );
    expect(titledLine('', '', CRYSTAL, false)).toEqual({
      themed: 'The Bard could not name your Quest.',
      plain: 'Naming this session failed',
    });
    expect(titledLine('', '', CLASSIC, false).themed).toBe('Naming this session failed');
  });

  it('names Errands, and Follow-ups in the Classic theme', () => {
    expect(w('errand', CRYSTAL)).toBe('Errand');
    expect(w('errands', CRYSTAL)).toBe('Errands');
    expect(w('errands', CLASSIC)).toBe('Follow-ups');
    expect(w('errand', CLASSIC)).toBe('Follow-up');
    expect(hint('errands', CRYSTAL)).toBe('Errands (steps your Quests left for you to take)');
  });

  it('says how many Errands a turn left', () => {
    expect(errandsLeftLine(2, CRYSTAL).themed).toBe('Your Quest left you 2 Errands.');
    expect(errandsLeftLine(1, CRYSTAL).themed).toBe('Your Quest left you an Errand.');
    expect(errandsLeftLine(2, CLASSIC).themed).toBe('This session left you 2 follow-ups.');
    expect(errandsLeftLine(2, CRYSTAL).plain).toBe('Left you 2 follow-ups');
    expect(errandsLeftLine(1, CRYSTAL).plain).toBe('Left you a follow-up');
    expect(errandsLeftLine(0, CRYSTAL)).toEqual({
      themed: 'Your Quest couldn’t leave you an Errand.',
      plain: 'Leaving a follow-up failed',
    });
  });

  it('says how many Errands a Patrol’s run left, mid-sentence, so Classic keeps its noun lowercase', () => {
    expect(errandsLeftPhrase(2, CRYSTAL)).toBe('left 2 Errands');
    expect(errandsLeftPhrase(1, CRYSTAL)).toBe('left an Errand');
    expect(errandsLeftPhrase(2, CLASSIC)).toBe('left 2 follow-ups');
    expect(errandsLeftPhrase(1, CLASSIC)).toBe('left a follow-up');
  });

  it('says where the Errands a turn left wait, one or more', () => {
    expect(errandsWaitLine(2, CRYSTAL)).toBe('They wait in the side panel and on the Castle.');
    expect(errandsWaitLine(1, CRYSTAL)).toBe('It waits in the side panel and on the Castle.');
    expect(errandsWaitLine(2, CLASSIC)).toBe('They wait in the side panel and on the Overview page.');
    expect(errandsWaitLine(1, CLASSIC)).toBe('It waits in the side panel and on the Overview page.');
  });

  it('names Errands in the panels, Classic’s noun lowercase mid-sentence', () => {
    const crystal = errandWords(CRYSTAL);
    expect(crystal.add).toBe('Add an Errand');
    expect(crystal.edit).toBe('Edit this Errand');
    expect(crystal.byYou).toBe('A new Errand, written by you');
    expect(crystal.noneOpen).toBe('No open Errands.');
    expect(crystal.questLeft).toBe('Steps this Quest left for you');
    expect(crystal.show).toBe('Show the Errands');
    expect(crystal.loadFailed).toBe('Couldn’t load Errands.');
    const classic = errandWords(CLASSIC);
    expect(classic.add).toBe('Add a follow-up');
    expect(classic.edit).toBe('Edit this follow-up');
    expect(classic.byYou).toBe('A new follow-up, written by you');
    expect(classic.noneOpen).toBe('No open follow-ups.');
    expect(classic.questLeft).toBe('Steps this session left for you');
    expect(classic.show).toBe('Show the follow-ups');
    expect(classic.showHint).toBe('Show this session’s follow-ups in the side panel');
    expect(classic.loadFailed).toBe('Couldn’t load follow-ups.');
  });

  it('names Deeds, and Outcomes and the Work log in the Classic theme', () => {
    expect(w('deed', CRYSTAL)).toBe('Deed');
    expect(w('deeds', CRYSTAL)).toBe('Deeds');
    expect(w('deedsFeed', CRYSTAL)).toBe('Deeds');
    expect(w('deed', CLASSIC)).toBe('Outcome');
    expect(w('deeds', CLASSIC)).toBe('Outcomes');
    expect(w('deedsFeed', CLASSIC)).toBe('Work log');
    expect(hint('deedsFeed', CLASSIC)).toBe('Work log (what your Quests achieved, day by day)');
  });

  it('says a Deed was recorded in a turn', () => {
    expect(deedRecordedLine(CRYSTAL).themed).toBe('A new Deed is recorded in the annals of the Kingdom.');
    expect(deedRecordedLine(CLASSIC).themed).toBe('Outcome recorded.');
    expect(deedRefusedLine(CRYSTAL).themed).toBe('Your Quest couldn’t record a Deed.');
  });

  it('says how the call at Close went', () => {
    expect(closingLine('recorded', CRYSTAL).themed).toBe(
      'Your Quest’s Deeds are recorded in the annals of the Kingdom.',
    );
    expect(closingLine('recorded', CLASSIC).themed).toBe('Summary recorded.');
    expect(closingLine('timeout', CRYSTAL).themed).toBe('No Deeds recorded: the call took too long.');
    expect(closingLine('timeout', CLASSIC).themed).toBe('No summary recorded: the call took too long.');
    expect(closingLine('budget', CRYSTAL).themed).toContain('the call went over its budget');
    expect(closingLine('empty', CRYSTAL).themed).toContain('the call wrote none');
    expect(closingLine('failed', CRYSTAL).themed).toContain('the call failed');
    expect(closingLine('unreadable', CRYSTAL).themed).toContain('the Quest’s transcript couldn’t be read');
  });

  it('names a Quest’s standing in the feed', () => {
    expect(questStandingWord({ kind: 'open' }, CRYSTAL).themed).toBe('Still open');
    expect(questStandingWord({ kind: 'deeds' }, CRYSTAL).themed).toBe('Closed with Deeds');
    expect(questStandingWord({ kind: 'deeds' }, CLASSIC).themed).toBe('Closed with outcomes');
    const why = (k: 'skipped' | 'timeout' | 'budget' | 'empty' | 'failed' | 'unreadable') =>
      questStandingWord({ kind: 'closed', why: k }, CRYSTAL).themed;
    expect(why('skipped')).toBe('Closed · skipped');
    expect(why('timeout')).toBe('Closed · too long');
    expect(why('budget')).toBe('Closed · over budget');
    expect(why('empty')).toBe('Closed · nothing written');
    expect(why('failed')).toBe('Closed · the call failed');
    expect(why('unreadable')).toBe('Closed · transcript unreadable');
  });

  it('offers the choice at Close', () => {
    expect(recordDeedsChoice(CRYSTAL)).toEqual({
      label: 'Record its Deeds',
      hint: 'Writes the Quest’s Deeds from a short digest of it, for a few cents.',
    });
    expect(recordDeedsChoice(CLASSIC).label).toBe('Record its outcomes');
  });

  it('words the Deeds’ short lines in each theme, and Classic never says Deed', () => {
    expect(deedsText(CRYSTAL)).toEqual({
      tooOld: 'This Kingdom is too old to record Deeds at Close.',
      noTurn: 'No finished turn to record.',
      none: 'None yet.',
      fromClose: 'From Close',
      fromTurn: 'From a turn',
    });
    expect(closingStoppedReason(CRYSTAL)).toBe('Crystal stopped before the Deeds came back.');
    const classic = deedsText(CLASSIC);
    expect(classic.tooOld).toBe('This node is too old to record outcomes at close.');
    expect(classic.fromClose).toBe('From close');
    expect(closingStoppedReason(CLASSIC)).toBe('Crystal stopped before the summary came back.');
    expect(JSON.stringify([classic, closingStoppedReason(CLASSIC)])).not.toMatch(/deed/i);
  });
});
