import { describe, expect, it } from 'vitest';
import {
  BoardAct,
  BoardItemsChange,
  HubScoutAction,
  HubScoutRunNow,
  HubToClient,
  MAX_SCOUT_ITEMS,
  NodeHello,
  NodeScoutActed,
  NodeScoutRun,
  NodeScouts,
  ScoutItems,
  ScoutLink,
  ScoutManifest,
} from './index.js';

const RUN = '11111111-1111-4111-8111-111111111111';

/** The example from docs/SCOUTS.md, so the page and the schema can't drift apart. */
const manifest = {
  name: 'Quest Board',
  schedule: { cron: '*/15 8-20 * * 1-5', timezone: 'America/Chicago' },
  collect: { command: ['./collect.sh'], timeoutSeconds: 120 },
  synthesize: { prompt: 'synthesize.md', when: 'changed' },
  view: 'list',
  actions: {
    fix: {
      kind: 'quest',
      label: 'Fix it',
      project: '{{fields.checkout}}',
      prompt: 'fix.md',
      mode: 'auto',
      worktree: true,
    },
    open: { kind: 'link', label: 'Open', url: '{{url}}' },
    snooze: { kind: 'snooze', label: 'Later', for: '1d' },
    done: { kind: 'done', label: 'Done' },
  },
};

const item = {
  id: 'github:pr:owner/repo#123',
  rev: '2026-11-17T10:02:00Z',
  title: 'Fix the retry loop',
  subtitle: 'owner/repo · checks failing',
  url: 'https://github.com/owner/repo/pull/123',
  group: 'Needs a fix',
  fields: { checkout: '~/code/repo', failing: 'test (ubuntu)' },
  actions: ['fix', 'open', 'snooze', 'done'],
};

describe('ScoutManifest', () => {
  it('accepts the example scout.json from the docs', () => {
    expect(ScoutManifest.parse(manifest)).toEqual(manifest);
  });

  it('needs a five-field cron and a time zone, so a Scout means the same on every machine', () => {
    const at = (schedule: unknown) => ScoutManifest.safeParse({ ...manifest, schedule }).success;
    expect(at({ cron: '0 9 * * *', timezone: 'UTC' })).toBe(true);
    expect(at({ cron: '0 9 * * *' })).toBe(false);
    expect(at({ cron: '0 9 * *', timezone: 'UTC' })).toBe(false);
    expect(at({ cron: '0 0 9 * * *', timezone: 'UTC' })).toBe(false);
  });

  it('takes only the action kinds it knows, under short lower-case keys', () => {
    const withActions = (actions: unknown) => ScoutManifest.safeParse({ ...manifest, actions }).success;
    expect(withActions({ archive: { kind: 'run', label: 'Archive', command: ['./act.sh', 'archive'] } })).toBe(true);
    expect(withActions({ archive: { kind: 'shell', label: 'Archive', command: ['rm'] } })).toBe(false);
    expect(withActions({ 'Not A Key': { kind: 'done', label: 'Done' } })).toBe(false);
    expect(withActions({ later: { kind: 'snooze', label: 'Later', for: 'tomorrow' } })).toBe(false);
  });

  it('keeps fields a newer Kingdom adds out of the way rather than refusing the Scout', () => {
    expect(ScoutManifest.safeParse({ ...manifest, triggers: [] }).success).toBe(true);
  });
});

describe('ScoutItems, what a collector prints', () => {
  it('accepts the example item from the docs, and an item with only an id and a title', () => {
    expect(ScoutItems.parse({ items: [item] })).toEqual({ items: [item] });
    expect(ScoutItems.safeParse({ items: [{ id: 'a', title: 'A' }] }).success).toBe(true);
  });

  it('refuses two items with one id, since everything the app remembers hangs on it', () => {
    expect(ScoutItems.safeParse({ items: [item, { ...item, title: 'again' }] }).success).toBe(false);
  });

  it('takes only web links, so a Board never opens a javascript: URL', () => {
    expect(ScoutItems.safeParse({ items: [{ ...item, url: 'javascript:alert(1)' }] }).success).toBe(false);
  });

  it('caps the list', () => {
    const many = Array.from({ length: MAX_SCOUT_ITEMS + 1 }, (_, n) => ({ id: `i${n}`, title: 't' }));
    expect(ScoutItems.safeParse({ items: many }).success).toBe(false);
  });
});

describe('Scout frames', () => {
  it('lets a Kingdom say it runs Scouts in hello, and an older one leave it out', () => {
    expect(NodeHello.parse({ kind: 'hello', node: 'n', scouts: true }).scouts).toBe(true);
    expect(NodeHello.parse({ kind: 'hello', node: 'n' }).scouts).toBeUndefined();
  });

  it('lists a Kingdom’s Scouts, one that loaded and one whose scout.json did not', () => {
    const frame = {
      kind: 'scouts',
      scouts: [
        { id: 'quest-board', manifest, nextRunAt: 5 },
        { id: 'mail', error: 'scout.json: schedule.timezone is required' },
      ],
    };
    expect(NodeScouts.parse(frame)).toEqual(frame);
    expect(NodeScouts.parse({ kind: 'scouts', scouts: [{ id: '../etc' }] }).scouts).toEqual([]);
  });

  it('reports a finished run with its full list, and a failed one without', () => {
    const run = { id: RUN, startedAt: 1, finishedAt: 2, trigger: 'schedule', outcome: 'succeeded', items: 1 };
    expect(NodeScoutRun.safeParse({ kind: 'scout-run', scout: 'quest-board', run, items: [item] }).success).toBe(true);
    const failed = { ...run, outcome: 'failed', reason: 'exit 1', stderr: 'gh: not logged in' };
    expect(NodeScoutRun.safeParse({ kind: 'scout-run', scout: 'quest-board', run: failed }).success).toBe(true);
    expect(NodeScoutRun.safeParse({ kind: 'scout-run', scout: 'quest-board', run: failed, items: [] }).success).toBe(
      false,
    );
  });

  it('keeps a Kingdom’s other Scouts when one uses something this hub doesn’t know, and says why', () => {
    const frame = NodeScouts.parse({
      kind: 'scouts',
      scouts: [
        { id: 'quest-board', manifest },
        { id: 'kanban', manifest: { ...manifest, view: 'kanban' } },
        { id: 'hook', manifest: { ...manifest, actions: { send: { kind: 'webhook', label: 'Send' } } } },
        { id: 'Not An Id' },
      ],
    });
    expect(frame.scouts.map((scout) => scout.id)).toEqual(['quest-board', 'kanban', 'hook']);
    expect(frame.scouts[0]).toEqual({ id: 'quest-board', manifest });
    expect(frame.scouts[1]?.manifest).toBeUndefined();
    expect(frame.scouts[1]?.error).toMatch(/newer/);
  });

  it('takes a run that started or ended in a way this hub doesn’t know yet', () => {
    const run = { id: RUN, startedAt: 1, trigger: 'webhook', outcome: 'cancelled' };
    expect(NodeScoutRun.safeParse({ kind: 'scout-run', scout: 'quest-board', run }).success).toBe(true);
  });

  it('refuses a list with one Scout twice', () => {
    expect(NodeScouts.safeParse({ kind: 'scouts', scouts: [{ id: 'a' }, { id: 'a' }] }).success).toBe(false);
  });

  it('carries Run now and an action to the Kingdom, and the action’s answer back', () => {
    expect(HubScoutRunNow.safeParse({ kind: 'scout-run-now', scout: 'quest-board' }).success).toBe(true);
    const action = { kind: 'scout-action', requestId: RUN, scout: 'quest-board', action: 'fix', items: [item] };
    expect(HubScoutAction.safeParse(action).success).toBe(true);
    expect(HubScoutAction.safeParse({ ...action, items: [] }).success).toBe(false);
    expect(NodeScoutActed.safeParse({ kind: 'scout-acted', requestId: RUN, ok: true, session: RUN }).success).toBe(
      true,
    );
  });

  it('tells clients about Scouts, a Board after a run, and items whose state changed', () => {
    const boardItem = { ...item, state: 'new', firstSeen: 1, changedAt: 1 };
    const frames = [
      { kind: 'scouts', node: 'n', scouts: [{ id: 'quest-board', manifest, fresh: 1 }] },
      { kind: 'board', node: 'n', board: { scout: 'quest-board', runs: [], items: [boardItem] } },
      { kind: 'board-items', node: 'n', scout: 'quest-board', items: [{ ...boardItem, state: 'done' }] },
    ];
    for (const frame of frames) expect(HubToClient.safeParse(frame).success).toBe(true);
  });
});

describe('BoardItemsChange', () => {
  it('changes several items at once, and a snooze says until when', () => {
    expect(BoardItemsChange.safeParse({ ids: ['a', 'b'], state: 'done' }).success).toBe(true);
    expect(BoardItemsChange.safeParse({ ids: ['a'], state: 'snoozed', until: 10 }).success).toBe(true);
    expect(BoardItemsChange.safeParse({ ids: ['a'], state: 'snoozed' }).success).toBe(false);
    expect(BoardItemsChange.safeParse({ ids: [], state: 'done' }).success).toBe(false);
  });
});

describe('BoardAct', () => {
  it('names one action and the items it acts on, by id only', () => {
    expect(BoardAct.parse({ action: 'fix', ids: ['a'] })).toEqual({ action: 'fix', ids: ['a'] });
    expect(BoardAct.safeParse({ action: 'fix', ids: [] }).success).toBe(false);
    expect(BoardAct.safeParse({ action: 'Not A Key', ids: ['a'] }).success).toBe(false);
  });
});

describe('a suggested action', () => {
  it('lets an item name one action as the suggested button, and only by key', () => {
    expect(ScoutItems.parse({ items: [{ ...item, suggested: 'fix' }] }).items[0]!.suggested).toBe('fix');
    expect(ScoutItems.safeParse({ items: [{ ...item, suggested: 'Fix it!' }] }).success).toBe(false);
  });
});

describe('what the synthesis step adds', () => {
  it('gives an item a rank from 1 and a one-line summary', () => {
    const ranked = ScoutItems.parse({ items: [{ ...item, rank: 1, summary: 'Checks fail on one runner.' }] }).items[0]!;
    expect([ranked.rank, ranked.summary]).toEqual([1, 'Checks fail on one runner.']);
    expect(ScoutItems.safeParse({ items: [{ ...item, rank: 0 }] }).success).toBe(false);
    expect(ScoutItems.safeParse({ items: [{ ...item, rank: 1.5 }] }).success).toBe(false);
    expect(ScoutItems.safeParse({ items: [{ ...item, summary: 'x'.repeat(301) }] }).success).toBe(false);
  });

  it('names where a rank or summary came from when the collector did not set it, as a short word', () => {
    const marked = ScoutItems.parse({
      items: [{ ...item, rank: 2, rankSource: 'synthesis', summary: 's', summarySource: 'synthesis' }],
    }).items[0]!;
    expect([marked.rankSource, marked.summarySource]).toEqual(['synthesis', 'synthesis']);
    expect(ScoutItems.safeParse({ items: [{ ...item, summarySource: 'a newer step' }] }).success).toBe(false);
  });

  it('lets a Scout cap what one synthesis may spend', () => {
    const capped = (maxBudgetUsd: unknown) =>
      ScoutManifest.safeParse({ ...manifest, synthesize: { prompt: 'synthesize.md', maxBudgetUsd } }).success;
    expect(capped(0.25)).toBe(true);
    expect(capped(0)).toBe(false);
    expect(capped(50)).toBe(false);
  });
});

describe('ScoutLink, the item a Quest came from', () => {
  it('names the Scout and the item, with the title as it was', () => {
    const link = { scout: 'quest-board', item: item.id, title: item.title };
    expect(ScoutLink.parse(link)).toEqual(link);
    expect(ScoutLink.safeParse({ ...link, scout: '../x' }).success).toBe(false);
  });
});
