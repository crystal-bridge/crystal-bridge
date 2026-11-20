import { describe, expect, it } from 'vitest';
import {
  BoardAct,
  BoardItemsChange,
  BoardQuest,
  HubScoutAction,
  HubScoutQuest,
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

  it('synthesizes when the list changed, or only on Run now', () => {
    for (const when of ['changed', 'now']) {
      expect(ScoutManifest.safeParse({ ...manifest, synthesize: { prompt: 'synthesize.md', when } }).success).toBe(
        true,
      );
    }
    expect(
      ScoutManifest.safeParse({ ...manifest, synthesize: { prompt: 'synthesize.md', when: 'hourly' } }).success,
    ).toBe(false);
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

  it("takes an icon for the Board's tab as a short lower-case name", () => {
    const icon = (value: unknown) => ScoutManifest.parse({ ...manifest, icon: value }).icon;
    expect(icon('mail')).toBe('mail');
    expect(icon('pull-request')).toBe('pull-request');
    // A badly written icon costs only the icon: the Scout still loads, and its tab shows its first letter.
    for (const bad of ['Mail', 'pull_request', '<svg>', 'a'.repeat(33), 5]) expect(icon(bad)).toBeUndefined();
  });

  it("takes counts for the Board's banner and the fields its rows show, and never fails a Scout over them", () => {
    const parsed = ScoutManifest.parse({
      ...manifest,
      summary: [{ label: 'Unread', field: 'unread' }],
      show: { who: 'from', whoKey: 'fromAddress', when: 'date', unread: 'unread', preview: 'body' },
    });
    expect(parsed.show?.whoKey).toBe('fromAddress');
    expect(parsed.summary).toEqual([{ label: 'Unread', field: 'unread' }]);
    expect(parsed.show).toEqual({
      who: 'from',
      whoKey: 'fromAddress',
      when: 'date',
      unread: 'unread',
      preview: 'body',
    });
    const bad = ScoutManifest.parse({ ...manifest, summary: [{ label: '' }], show: { who: 5 } });
    expect(bad.summary).toBeUndefined();
    expect(bad.show).toBeUndefined();
    const tooMany = Array.from({ length: 7 }, (_, i) => ({ label: `L${i}`, field: 'f' }));
    expect(ScoutManifest.parse({ ...manifest, summary: tooMany }).summary).toBeUndefined();
  });

  it('takes an icon and a tone per group, and drops a bad one alone', () => {
    const groups = (value: unknown) => ScoutManifest.parse({ ...manifest, groups: value }).groups;
    expect(groups({ Primary: { icon: 'star', tone: 'violet' } })).toEqual({
      Primary: { icon: 'star', tone: 'violet' },
    });
    // A bad name costs only that name, and a look with nothing left goes, leaving the rest.
    expect(groups({ Primary: { icon: 'Star!', tone: 'violet' }, Updates: 5, Social: {} })).toEqual({
      Primary: { tone: 'violet' },
    });
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`G${i}`, { tone: 'sky' }]));
    expect(groups(many)).toBeUndefined();
    expect(groups('Primary')).toBeUndefined();
    // A name no item could carry drops alone too, not the whole map.
    expect(groups({ '': { tone: 'red' }, ['x'.repeat(81)]: { tone: 'red' }, Updates: { tone: 'sky' } })).toEqual({
      Updates: { tone: 'sky' },
    });
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

describe('a Quest from Board items, with the user-s own prompt', () => {
  it('takes up to 50 items, the prompt and optionally where and how it runs', () => {
    const ask = { ids: ['a', 'b'], prompt: 'Work through these with me.', project: '~/code', mode: 'auto' };
    expect(BoardQuest.parse(ask)).toEqual(ask);
    expect(BoardQuest.safeParse({ ...ask, ids: [] }).success).toBe(false);
    expect(BoardQuest.safeParse({ ...ask, ids: Array.from({ length: 51 }, (_, i) => `i${i}`) }).success).toBe(false);
    expect(BoardQuest.safeParse({ ...ask, prompt: '  ' }).success).toBe(false);
    expect(BoardQuest.safeParse({ ...ask, mode: 'yolo' }).success).toBe(false);
  });

  it('reaches the Kingdom as its own frame, with the items as the hub stores them', () => {
    const frame = {
      kind: 'scout-quest',
      requestId: '22222222-2222-4222-8222-222222222222',
      scout: 'gmail',
      items: [{ id: 'a', title: 'A' }],
      prompt: 'Help me with this.',
    };
    expect(HubScoutQuest.parse(frame)).toEqual(frame);
    expect(HubScoutQuest.safeParse({ ...frame, items: [] }).success).toBe(false);
  });
});

describe('the projects view', () => {
  const projects = {
    kind: { field: 'kind', values: { pr: { icon: 'pull-request', tone: 'emerald', label: 'Pull request' } } },
    marks: [{ field: 'checks', values: { fail: { icon: 'x-circle', tone: 'red', label: 'Checks failing' } } }],
    reasons: { field: 'reason', values: { review: { icon: 'eye', tone: 'violet', label: 'Review requested' } } },
    who: 'author',
    whoKey: 'login',
    when: 'updated',
    comments: 'comments',
    added: 'added',
    removed: 'removed',
    mine: 'mine',
  };

  it('accepts view "projects" with a projects block', () => {
    const parsed = ScoutManifest.parse({ ...manifest, view: 'projects', projects });
    expect(parsed.view).toBe('projects');
    expect(parsed.projects).toEqual(projects);
  });

  it('drops a malformed projects block, keeping the Scout', () => {
    const parsed = ScoutManifest.parse({ ...manifest, view: 'projects', projects: { marks: 'x' } });
    expect(parsed.view).toBe('projects');
    expect(parsed.projects).toBeUndefined();
  });

  it('drops the block when marks has more than four entries', () => {
    const mark = { field: 'checks', values: {} };
    const parsed = ScoutManifest.parse({ ...manifest, view: 'projects', projects: { marks: Array(5).fill(mark) } });
    expect(parsed.projects).toBeUndefined();
  });

  it('keeps an item’s labels and project', () => {
    const extra = {
      labels: [{ name: 'bug', color: '#d73a4a' }],
      project: { name: 'acme/lantern', url: 'https://github.com/acme/lantern', description: 'Log viewer', owned: true },
    };
    const parsed = ScoutItems.parse({ items: [{ ...item, ...extra }] });
    expect(parsed.items[0]?.labels).toEqual(extra.labels);
    expect(parsed.items[0]?.project).toEqual(extra.project);
  });

  it('drops bad labels or a nameless project without failing the item', () => {
    const parsed = ScoutItems.parse({
      items: [
        { ...item, labels: [{ name: 'bug', color: 'red' }], project: { url: 'https://github.com/acme/lantern' } },
      ],
    });
    expect(parsed.items[0]?.id).toBe(item.id);
    expect(parsed.items[0]?.labels).toBeUndefined();
    expect(parsed.items[0]?.project).toBeUndefined();
  });

  it('keeps a summary entry’s icon and tone, and drops a bad one alone', () => {
    const good = { label: 'Failing', field: 'checks', icon: 'x-circle', tone: 'red' };
    const parsed = ScoutManifest.parse({
      ...manifest,
      summary: [good, { label: 'Open', field: 'open', icon: 'Bad Icon' }],
    });
    expect(parsed.summary).toEqual([good, { label: 'Open', field: 'open' }]);
  });

  describe('limits', () => {
    const block = (extra: object) => ScoutManifest.parse({ ...manifest, view: 'projects', projects: extra });
    const looks = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, at) => [`v${at}`, { icon: 'bug', tone: 'red' }]));
    const parseItem = (extra: object) => ScoutItems.parse({ items: [{ ...item, ...extra }] }).items[0]!;
    const labels = (count: number) => Array.from({ length: count }, (_, at) => ({ name: `l${at}`, color: '#d73a4a' }));

    it('keeps 24 values of a field and drops the block at 25', () => {
      expect(block({ kind: { field: 'kind', values: looks(24) } }).projects).toBeDefined();
      expect(block({ kind: { field: 'kind', values: looks(25) } }).projects).toBeUndefined();
    });

    it('drops the block for an icon or tone name that is not a name', () => {
      expect(block({ kind: { field: 'kind', values: { a: { icon: 'pull-request' } } } }).projects).toBeDefined();
      expect(block({ kind: { field: 'kind', values: { a: { icon: 'Pull Request' } } } }).projects).toBeUndefined();
      expect(block({ kind: { field: 'kind', values: { a: { tone: 'Pull Request' } } } }).projects).toBeUndefined();
    });

    it('keeps 10 labels and drops them at 11, keeping the item', () => {
      expect(parseItem({ labels: labels(10) }).labels).toHaveLength(10);
      const dropped = parseItem({ labels: labels(11) });
      expect(dropped.labels).toBeUndefined();
      expect(dropped.id).toBe(item.id);
    });

    it('drops labels for a 3-digit hex colour or a name over 50 characters', () => {
      expect(parseItem({ labels: [{ name: 'a'.repeat(50), color: '#ffffff' }] }).labels).toHaveLength(1);
      expect(parseItem({ labels: [{ name: 'bug', color: '#fff' }] }).labels).toBeUndefined();
      expect(parseItem({ labels: [{ name: 'a'.repeat(51), color: '#ffffff' }] }).labels).toBeUndefined();
    });

    it('drops a project whose description is over 200 characters or whose owned is not a boolean', () => {
      expect(parseItem({ project: { name: 'acme/lantern', description: 'd'.repeat(200) } }).project).toBeDefined();
      expect(parseItem({ project: { name: 'acme/lantern', description: 'd'.repeat(201) } }).project).toBeUndefined();
      expect(parseItem({ project: { name: 'acme/lantern', owned: 'yes' } }).project).toBeUndefined();
    });

    it('keeps only web links as a project url, dropping the project for any other scheme', () => {
      const url = 'https://example.com/acme/lantern';
      expect(parseItem({ project: { name: 'acme/lantern', url } }).project?.url).toBe(url);
      for (const bad of ['javascript:alert(1)', 'data:text/html,x']) {
        const parsed = parseItem({ project: { name: 'acme/lantern', url: bad } });
        expect(parsed.project).toBeUndefined();
        expect(parsed.id).toBe(item.id);
      }
    });
  });

  describe('the queue lane', () => {
    const block = (extra: object) => ScoutManifest.parse({ ...manifest, view: 'projects', projects: extra }).projects;
    const reasons = (look: object) => ({ field: 'reason', values: { next: { icon: 'flag', ...look } } });

    it('keeps a reason value’s lane and the queue block', () => {
      const queue = { title: 'Your queue', priority: 'priority', due: 'due' };
      const parsed = block({ reasons: reasons({ lane: 'queue' }), queue });
      expect(parsed?.reasons?.values.next?.lane).toBe('queue');
      expect(parsed?.queue).toEqual(queue);
      expect(block({ reasons: reasons({ lane: 'needs' }) })?.reasons?.values.next?.lane).toBe('needs');
    });

    it('drops an unknown lane alone, keeping the block and the look', () => {
      const parsed = block({ reasons: reasons({ lane: 'someday' }), who: 'author' });
      expect(parsed?.who).toBe('author');
      expect(parsed?.reasons?.values.next).toEqual({ icon: 'flag' });
    });

    it('drops a bad queue block alone', () => {
      const parsed = block({ who: 'author', queue: { title: 't'.repeat(41) } });
      expect(parsed?.who).toBe('author');
      expect(parsed?.queue).toBeUndefined();
      expect(block({ queue: { priority: 'Not a field'.repeat(10) } })?.queue).toBeUndefined();
      expect(block({ queue: {} })?.queue).toEqual({});
    });
  });

  it('NodeScouts on this hub reads a projects Scout', () => {
    const frame = NodeScouts.parse({
      kind: 'scouts',
      scouts: [{ id: 'board', manifest: { ...manifest, view: 'projects', projects } }],
    });
    expect(frame.scouts[0]?.error).toBeUndefined();
    expect(frame.scouts[0]?.manifest?.projects).toEqual(projects);
  });
});
