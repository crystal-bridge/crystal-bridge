import { describe, expect, it, vi } from 'vitest';
import type { BoardItem, ScoutManifest } from '@crystal-bridge/protocol';
import {
  FOLD_AT,
  activity,
  dueDays,
  dayOf,
  dueText,
  needsYou,
  priorityTone,
  projectOf,
  projectSections,
  queueSlots,
  rowLook,
  tileCounts,
  visibleRows,
  yourQueue,
} from './projects.js';
import { projectTone } from './theme/boardTones.js';

type Look = NonNullable<ScoutManifest['projects']>;

const look: Look = {
  kind: { field: 'kind', values: { pr: { icon: 'pull' }, draft: { icon: 'draft' }, issue: { icon: 'issue' } } },
  marks: [
    { field: 'ci', values: { failing: { icon: 'x', tone: 'red' } } },
    { field: 'review', values: { asked: {} } },
  ],
  reasons: { field: 'reason', values: { review: { label: 'Review asked' }, failing: { label: 'CI failing' } } },
  who: 'author',
  whoKey: 'login',
  when: 'updated',
  comments: 'comments',
  added: 'plus',
  removed: 'minus',
  mine: 'mine',
};

let n = 0;
const item = (fields: Record<string, unknown>, extra: Partial<BoardItem> = {}): BoardItem =>
  ({ id: `i${n++}`, title: 't', fields, ...extra }) as BoardItem;

const day = (iso: string) => Date.parse(iso);

describe('projectOf', () => {
  it('prefers the project, then the group, then Other', () => {
    expect(projectOf(item({}, { project: { name: 'acme/lantern' }, group: 'g' }))).toBe('acme/lantern');
    expect(projectOf(item({}, { group: 'orbit/ui' }))).toBe('orbit/ui');
    expect(projectOf(item({}))).toBe('Other');
  });
});

describe('projectSections', () => {
  it('groups by project and reads the first url, description and owned', () => {
    const items = [
      item({}, { project: { name: 'acme/lantern' } }),
      item({}, { project: { name: 'acme/lantern', url: 'https://x.test/l', description: 'd', owned: true } }),
      item({}, { project: { name: 'acme/tidepool', url: 'https://x.test/t' } }),
    ];
    const sections = projectSections(items, look);
    expect(sections.map((s) => s.name)).toEqual(['acme/lantern', 'acme/tidepool']);
    expect(sections[0]).toMatchObject({
      url: 'https://x.test/l',
      description: 'd',
      owned: true,
      tone: projectTone('acme/lantern'),
    });
    expect(sections[0]!.items).toHaveLength(2);
  });

  it('puts Needs-you projects first, then newest, then first seen', () => {
    const items = [
      item({ updated: 1000 }, { project: { name: 'a' } }),
      item({ updated: 5000 }, { project: { name: 'b' } }),
      item({ updated: 1000, reason: 'review' }, { project: { name: 'c' } }),
      item({}, { project: { name: 'd' } }),
      item({}, { project: { name: 'e' } }),
    ];
    const sections = projectSections(items, look);
    expect(sections.map((s) => s.name)).toEqual(['c', 'b', 'a', 'd', 'e']);
    expect(sections[0]).toMatchObject({ needs: 1, latest: 1_000_000 });
    expect(sections[3]!.latest).toBeUndefined();
  });

  it('orders items by kind, then newest, then input order', () => {
    const a = item({ kind: 'issue', updated: 9000 }, { project: { name: 'p' } });
    const b = item({ kind: 'pr', updated: 1000 }, { project: { name: 'p' } });
    const c = item({ kind: 'pr', updated: 2000 }, { project: { name: 'p' } });
    const d = item({ kind: 'draft' }, { project: { name: 'p' } });
    const e = item({ kind: 'other' }, { project: { name: 'p' } });
    const f = item({ kind: 'other' }, { project: { name: 'p' } });
    const [section] = projectSections([a, b, c, d, e, f], look);
    expect(section!.items).toEqual([c, b, d, a, e, f]);
  });

  it('still groups with no look, and files the unplaced under Other', () => {
    const sections = projectSections([item({}, { group: 'orbit/ui' }), item({})], undefined);
    expect(sections.map((s) => s.name)).toEqual(['orbit/ui', 'Other']);
    expect(sections[0]!.needs).toBe(0);
  });
});

describe('rowLook', () => {
  it('reads each slot from the fields the manifest names', () => {
    const row = rowLook(
      item({
        kind: 'pr',
        ci: 'failing',
        review: 'asked',
        reason: 'review',
        author: 'Ada',
        login: 'ada1',
        updated: '2026-11-17T10:00:00Z',
        comments: '4',
        plus: 12,
        minus: 'x',
        mine: 1,
      }),
      look,
    );
    expect(row).toEqual({
      kind: { icon: 'pull' },
      marks: [
        { field: 'ci', look: { icon: 'x', tone: 'red' } },
        { field: 'review', look: {} },
      ],
      reason: { label: 'Review asked' },
      who: 'Ada',
      whoKey: 'ada1',
      when: day('2026-11-17T10:00:00Z'),
      comments: 4,
      added: 12,
      removed: undefined,
      mine: true,
    });
  });

  it('leaves unlisted values and a missing look empty', () => {
    const row = rowLook(item({ kind: 'wat', ci: 'passing' }), look);
    expect(row.kind).toBeUndefined();
    expect(row.marks).toEqual([]);
    expect(row.mine).toBe(false);
    const bare = rowLook(item({ kind: 'pr' }), undefined);
    expect(bare).toEqual({
      kind: undefined,
      marks: [],
      reason: undefined,
      who: undefined,
      whoKey: undefined,
      when: undefined,
      comments: undefined,
      added: undefined,
      removed: undefined,
      mine: false,
    });
  });
});

describe('needsYou', () => {
  it('lists items with a reason by rank, reason order, newest, then input', () => {
    const a = item({ reason: 'failing', updated: 1 });
    const b = item({ reason: 'review', updated: 1 });
    const c = item({ reason: 'review', updated: 5 });
    const d = item({ reason: 'review', updated: 5 }, { rank: 2 });
    const e = item({ reason: 'failing' }, { rank: 1 });
    const none = item({ reason: 'nope' });
    expect(needsYou([a, b, none, c, d, e], look)).toEqual([e, d, c, b, a]);
    expect(needsYou([a], undefined)).toEqual([]);
  });
});

describe('activity', () => {
  it('counts items per local day, oldest first', () => {
    const now = new Date(2026, 10, 18, 15).getTime();
    const at = (d: number, h: number) => new Date(2026, 10, d, h).getTime();
    const items = [
      item({ updated: at(18, 1) }),
      item({ updated: new Date(2026, 10, 18, 9).toISOString() }),
      item({ updated: Math.floor(at(17, 12) / 1000) }),
      item({ updated: at(5, 12) }),
      item({ updated: at(4, 12) }),
      item({ updated: at(1, 12) }),
      item({ updated: at(19, 12) }),
      item({}),
    ];
    const counts = activity(items, 'updated', now);
    expect(counts).toHaveLength(14);
    expect(counts[13]).toBe(2);
    expect(counts[12]).toBe(1);
    expect(counts[0]).toBe(1);
    expect(counts.reduce((x, y) => x + y, 0)).toBe(4);
    expect(activity(items, 'updated', now, 3)).toEqual([0, 1, 2]);
  });
});

describe('tileCounts', () => {
  it('leads with Needs you, then the first three summary counts', () => {
    const [section] = projectSections(
      [
        item({ reason: 'review', draft: true, bug: 0 }, { project: { name: 'p' } }),
        item({ draft: 1 }, { project: { name: 'p' } }),
      ],
      look,
    );
    const summary = [
      { label: 'Drafts', field: 'draft', icon: 'draft', tone: 'blue' },
      { label: 'Bugs', field: 'bug' },
      { label: 'C', field: 'c' },
      { label: 'D', field: 'draft' },
    ] as NonNullable<ScoutManifest['summary']>;
    expect(tileCounts(section!, summary)).toEqual([
      { label: 'Needs you', count: 1, icon: 'hand', tone: 'amber' },
      { label: 'Drafts', count: 2, icon: 'draft', tone: 'blue' },
      { label: 'Bugs', count: 0 },
      { label: 'C', count: 0 },
    ]);
    expect(tileCounts(section!, undefined)).toHaveLength(1);
  });
});

describe('visibleRows', () => {
  const rows = Array.from({ length: 10 }, (_, i) => i);
  it('folds past eight unless expanded', () => {
    expect(FOLD_AT).toBe(8);
    expect(visibleRows(rows, false)).toEqual({ shown: rows.slice(0, 8), hidden: 2 });
    expect(visibleRows(rows, true)).toEqual({ shown: rows, hidden: 0 });
    expect(visibleRows(rows.slice(0, 8), false)).toEqual({ shown: rows.slice(0, 8), hidden: 0 });
  });
});

describe('the queue lane', () => {
  const lanes: Look = {
    ...look,
    reasons: {
      field: 'reason',
      values: { review: { label: 'Review asked' }, next: { label: 'Up next', lane: 'queue' }, mine: { lane: 'needs' } },
    },
    queue: { priority: 'priority', due: 'due' },
  };

  it('keeps queue-lane items out of Needs you', () => {
    const a = item({ reason: 'review' });
    const b = item({ reason: 'next' });
    const c = item({ reason: 'mine' });
    expect(needsYou([a, b, c], lanes)).toEqual([a, c]);
  });

  it('keeps everything in Needs you for a look without lanes', () => {
    const a = item({ reason: 'review' });
    const b = item({ reason: 'failing' });
    expect(needsYou([a, b], look)).toEqual([a, b]);
    expect(yourQueue([a, b], look)).toEqual([]);
  });

  it('orders the queue by priority, then due, then oldest, then input', () => {
    const p2 = item({ reason: 'next', priority: 2 });
    const p0 = item({ reason: 'next', priority: '0' });
    const p1late = item({ reason: 'next', priority: 1, due: '2026-12-20T00:00:00Z' });
    const p1soon = item({ reason: 'next', priority: 1, due: Math.floor(day('2026-12-01T00:00:00Z') / 1000) });
    const p1none = item({ reason: 'next', priority: 1 });
    const oldNone = item({ reason: 'next', updated: 1000 });
    const newNone = item({ reason: 'next', updated: 5000 });
    const undated = item({ reason: 'next' });
    const tieA = item({ reason: 'next' });
    const bad = item({ reason: 'next', priority: 'high', due: 'soon' });
    const review = item({ reason: 'review', priority: 0 });
    expect(yourQueue([undated, p2, newNone, review, p1none, p0, tieA, p1late, oldNone, bad, p1soon], lanes)).toEqual([
      p0,
      p1soon,
      p1late,
      p1none,
      p2,
      oldNone,
      newNone,
      undated,
      tieA,
      bad,
    ]);
  });

  it('reads a date-only due as the local day west of Greenwich too, where UTC midnight is the evening before', () => {
    // CI runs in UTC, where both readings agree, so this pins a western zone for the one case that tells them apart.
    vi.stubEnv('TZ', 'America/Los_Angeles');
    try {
      // The zone only takes in a process of its own (Vitest's forks pool): say so rather than pass without teeth.
      expect(new Date(2026, 10, 19, 20).getTimezoneOffset()).toBe(480);
      const evening = new Date(2026, 10, 19, 20).getTime();
      expect(dueText(dayOf('2026-11-19')!, evening)).toBe('due today');
      expect(dueText(dayOf('2026-11-20')!, evening)).toBe('due in 1d');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reads an item’s priority and due', () => {
    // A date-only due is that local calendar day, whatever the zone.
    expect(queueSlots(item({ priority: '1', due: '2026-12-01' }), lanes)).toEqual({
      priority: 1,
      due: new Date(2026, 11, 1).getTime(),
    });
    // A full timestamp is the local day it falls on.
    const stamp = new Date(2026, 11, 1, 15, 30);
    expect(queueSlots(item({ due: stamp.getTime() }), lanes).due).toBe(new Date(2026, 11, 1).getTime());
    expect(queueSlots(item({ priority: null }), lanes)).toEqual({ priority: undefined, due: undefined });
    expect(queueSlots(item({ priority: 1 }), look)).toEqual({ priority: undefined, due: undefined });
  });

  it('counts only needs-lane items as needs', () => {
    const sections = projectSections(
      [
        item({ reason: 'next', updated: 9000 }, { project: { name: 'mine' } }),
        item({ reason: 'next' }, { project: { name: 'mine' } }),
        item({ reason: 'review', updated: 1000 }, { project: { name: 'theirs' } }),
      ],
      lanes,
    );
    expect(sections.map((s) => [s.name, s.needs])).toEqual([
      ['theirs', 1],
      ['mine', 0],
    ]);
    expect(tileCounts(sections[1]!, undefined)[0]).toMatchObject({ label: 'Needs you', count: 0 });
  });

  it('words a due date by calendar days, not elapsed hours', () => {
    const at = (d: number, h = 12) => new Date(2026, 10, d, h).getTime();
    const now = at(19, 23);
    expect(dueText(at(19, 0), now)).toBe('due today');
    expect(dueDays(at(19, 0), now)).toBe(0);
    expect(dueText(at(20, 23), at(19, 0))).toBe('due in 1d');
    expect(dueText(at(20, 23), at(19, 23))).toBe('due in 1d');
    expect(dueText(at(22), at(19))).toBe('due in 3d');
    expect(dueText(at(18, 23), at(19, 1))).toBe('overdue 1d');
    expect(dueText(at(17), at(19))).toBe('overdue 2d');
    expect(dueDays(queueSlots(item({ due: '2026-11-19' }), lanes).due!, at(19, 23))).toBe(0);
    expect(dueText(queueSlots(item({ due: '2026-11-20' }), lanes).due!, at(19, 23))).toBe('due in 1d');
    expect(dueText(queueSlots(item({ due: '2026-11-18' }), lanes).due!, at(19, 1))).toBe('overdue 1d');
    expect([0, 1, 2, 3, 7].map(priorityTone)).toEqual(['red', 'orange', 'amber', 'slate', 'slate']);
  });
});
