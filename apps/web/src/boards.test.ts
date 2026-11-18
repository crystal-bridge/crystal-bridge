import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { Board, BoardItem, ListedScout, ScoutManifest } from '@crystal-bridge/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardsFrame, HubClient } from './hub.js';
import {
  actionsFor,
  batchesFor,
  boardSections,
  linkFor,
  snoozeUntil,
  tableColumns,
  useBoard,
  useScouts,
  withBoardItems,
} from './boards.js';

const item = (extra: Partial<BoardItem> = {}): BoardItem => ({
  id: 'a',
  title: 'Fix the retry loop',
  state: 'new',
  firstSeen: 0,
  changedAt: 0,
  ...extra,
});

const manifest: ScoutManifest = {
  name: 'Quest Board',
  schedule: { cron: '*/15 * * * *', timezone: 'UTC' },
  collect: { command: ['./collect.sh'] },
  view: 'list',
  actions: {
    open: { kind: 'link', label: 'Open', url: '{{url}}' },
    search: { kind: 'link', label: 'Search', url: 'https://example.com/search?q={{fields.query}}' },
    later: { kind: 'snooze', label: 'Later', for: '1d' },
    done: { kind: 'done', label: 'Done' },
  },
  defaults: ['done'],
};

describe('snoozeUntil', () => {
  it('counts minutes, hours, days and weeks from now', () => {
    expect(snoozeUntil('30m', 1_000)).toBe(1_000 + 30 * 60_000);
    expect(snoozeUntil('2h', 0)).toBe(2 * 3_600_000);
    expect(snoozeUntil('1d', 0)).toBe(86_400_000);
    expect(snoozeUntil('1w', 0)).toBe(7 * 86_400_000);
  });
});

describe('linkFor', () => {
  it('puts a whole-template placeholder in as it is, and escapes one inside a longer address', () => {
    const found = item({ url: 'https://github.com/o/r/pull/1', fields: { query: 'a b&c' } });
    expect(linkFor('{{url}}', found)).toBe('https://github.com/o/r/pull/1');
    expect(linkFor('https://example.com/search?q={{fields.query}}', found)).toBe(
      'https://example.com/search?q=a%20b%26c',
    );
  });

  it('refuses anything that isn’t a web address once filled, since item text is untrusted', () => {
    expect(linkFor('{{fields.where}}', item({ fields: { where: 'javascript:alert(1)' } }))).toBeUndefined();
    expect(linkFor('{{fields.where}}', item({ fields: { where: 'not a url' } }))).toBeUndefined();
    expect(linkFor('{{url}}', item())).toBeUndefined();
    expect(linkFor('https://x.test/{{fields.missing}}', item())).toBeUndefined();
    expect(linkFor('https://x.test/?q={{fields.constructor}}', item({ fields: {} }))).toBeUndefined();
  });
});

describe('actionsFor', () => {
  it('gives an item the actions it names, in its order, skipping keys the Scout doesn’t declare', () => {
    const keys = actionsFor(item({ actions: ['done', 'nope', 'open'] }), manifest).map((a) => a.key);
    expect(keys).toEqual(['done', 'open']);
  });

  it('falls back to the Scout’s defaults for an item that names none', () => {
    expect(actionsFor(item(), manifest).map((a) => a.key)).toEqual(['done']);
    expect(actionsFor(item(), { ...manifest, defaults: undefined })).toEqual([]);
  });

  it('includes the actions a Kingdom carries out', () => {
    const withQuest: ScoutManifest = {
      ...manifest,
      actions: { ...manifest.actions, fix: { kind: 'quest', label: 'Fix', project: '~/code/r', prompt: 'fix.md' } },
    };
    expect(actionsFor(item({ actions: ['fix', 'done'] }), withQuest).map((a) => a.key)).toEqual(['fix', 'done']);
  });
});

describe('batchesFor', () => {
  const batching: ScoutManifest = {
    ...manifest,
    actions: {
      ...manifest.actions,
      archive: { kind: 'run', label: 'Archive', command: ['./act.sh'], batch: true },
      tidy: { kind: 'run', label: 'Tidy', command: ['./act.sh'] },
    },
  };

  it('offers a batch action once for the items that offer it, when there are several', () => {
    const items = [
      item({ id: 'a', actions: ['archive', 'tidy'] }),
      item({ id: 'b', actions: ['archive', 'tidy'] }),
      item({ id: 'c', actions: ['done'] }),
    ];
    expect(batchesFor(items, batching)).toEqual([
      { key: 'archive', action: batching.actions.archive, ids: ['a', 'b'] },
    ]);
  });

  it('offers nothing for a single item, which has its own button', () => {
    expect(batchesFor([item({ actions: ['archive'] })], batching)).toEqual([]);
  });
});

describe('boardSections', () => {
  it('groups open items in the collector’s order, and sets aside the rest', () => {
    const items = [
      item({ id: '1', group: 'Needs a fix' }),
      item({ id: '2', group: 'Waiting' }),
      item({ id: '3', group: 'Needs a fix', state: 'seen' }),
      item({ id: '4', state: 'snoozed', until: 5_000 }),
      item({ id: '5', state: 'done' }),
      item({ id: '6', state: 'dismissed' }),
      item({ id: '7', goneAt: 10 }),
      item({ id: '8' }),
    ];
    const sections = boardSections(items, 1_000);
    expect(sections.open.map((g) => [g.group, g.items.map((i) => i.id)])).toEqual([
      ['Needs a fix', ['1', '3']],
      ['Waiting', ['2']],
      [undefined, ['8']],
    ]);
    expect(sections.snoozed.map((i) => i.id)).toEqual(['4']);
    expect(sections.setAside.map((i) => i.id)).toEqual(['5', '6']);
    expect(sections.gone.map((i) => i.id)).toEqual(['7']);
  });

  it('puts ranked items first by rank, the rest in the collector-s order, and each group where its best item is', () => {
    const items = [
      item({ id: '1', group: 'Waiting' }),
      item({ id: '2', group: 'Needs a fix', rank: 3 }),
      item({ id: '3', group: 'Waiting', rank: 2 }),
      item({ id: '4', group: 'Needs a fix', rank: 1 }),
      item({ id: '5', group: 'Waiting' }),
    ];
    expect(boardSections(items, 1_000).open.map((g) => [g.group, g.items.map((i) => i.id)])).toEqual([
      ['Needs a fix', ['4', '2']],
      ['Waiting', ['3', '1', '5']],
    ]);
  });

  it('brings a snooze back as new once its time has passed', () => {
    const sections = boardSections([item({ id: '4', state: 'snoozed', until: 5_000 })], 6_000);
    expect(sections.open[0]!.items[0]).toMatchObject({ id: '4', state: 'new' });
    expect(sections.snoozed).toEqual([]);
  });
});

describe('tableColumns', () => {
  it('lists each field once, in the order items first use them', () => {
    const items = [
      item({ fields: { repo: 'r', checks: 'ok' } }),
      item({ id: 'b', fields: { author: 'x', repo: 's' } }),
    ];
    expect(tableColumns(items)).toEqual(['repo', 'checks', 'author']);
  });
});

describe('withBoardItems', () => {
  it('replaces the items that changed and keeps the rest where they were', () => {
    const board: Board = { scout: 'qb', runs: [], items: [item({ id: '1' }), item({ id: '2' })] };
    const next = withBoardItems(board, [item({ id: '2', state: 'done' }), item({ id: 'x' })]);
    expect(next.items.map((i) => [i.id, i.state])).toEqual([
      ['1', 'new'],
      ['2', 'done'],
    ]);
  });
});

/** The hub as the hooks see it: a test delivers frames and brings the socket back. */
function fakeHub() {
  const listeners = new Set<(frame: BoardsFrame) => void>();
  const reconnects = new Set<() => void>();
  const hub = {
    onBoards(listener: (frame: BoardsFrame) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onReconnect(listener: () => void) {
      reconnects.add(listener);
      return () => reconnects.delete(listener);
    },
  } as unknown as HubClient;
  return {
    hub,
    frame: (frame: BoardsFrame) => listeners.forEach((listener) => listener(frame)),
    reconnect: () => reconnects.forEach((listener) => listener()),
  };
}

/** Each fetch waits until a test answers it, so the order of a reply and a frame is the test's. */
function fakeFetch() {
  const pending: { url: string; answer: (body: unknown) => void }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string) =>
        new Promise((resolve) =>
          pending.push({
            url,
            answer: (body) =>
              resolve(
                body === undefined
                  ? { ok: false, status: 404, json: async () => ({}) }
                  : { ok: true, status: 200, json: async () => body },
              ),
          }),
        ),
    ),
  );
  return pending;
}

const listed = (extra: Partial<ListedScout> = {}): ListedScout => ({ id: 'qb', fresh: 0, manifest, ...extra });

describe('useScouts', () => {
  let pending: ReturnType<typeof fakeFetch>;
  beforeEach(() => {
    pending = fakeFetch();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('loads a Kingdom’s Scouts, takes its frames and ignores other Kingdoms’', async () => {
    const { hub, frame } = fakeHub();
    const { result } = renderHook(() => useScouts(hub, 'forge'));
    expect(pending[0]!.url).toBe('/api/nodes/forge/scouts');
    act(() => pending[0]!.answer({ scouts: [listed()] }));
    await waitFor(() => expect(result.current.map((s) => s.fresh)).toEqual([0]));
    act(() => frame({ kind: 'scouts', node: 'elsewhere', scouts: [] }));
    act(() => frame({ kind: 'scouts', node: 'forge', scouts: [listed({ fresh: 3 })] }));
    expect(result.current.map((s) => s.fresh)).toEqual([3]);
  });

  it('keeps a frame that lands while the list is on its way', async () => {
    const { hub, frame } = fakeHub();
    const { result } = renderHook(() => useScouts(hub, 'forge'));
    act(() => frame({ kind: 'scouts', node: 'forge', scouts: [listed({ fresh: 5 })] }));
    act(() => pending[0]!.answer({ scouts: [listed({ fresh: 1 })] }));
    await act(async () => {});
    expect(result.current.map((s) => s.fresh)).toEqual([5]);
  });

  it('reads the list again when the socket comes back', async () => {
    const { hub, reconnect } = fakeHub();
    renderHook(() => useScouts(hub, 'forge'));
    act(() => reconnect());
    expect(pending.map((p) => p.url)).toEqual(['/api/nodes/forge/scouts', '/api/nodes/forge/scouts']);
  });
});

describe('useBoard', () => {
  let pending: ReturnType<typeof fakeFetch>;
  beforeEach(() => {
    pending = fakeFetch();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const board = (items: BoardItem[]): Board => ({ scout: 'qb', runs: [], items });

  it('loads a Board, then takes whole Boards and item changes for it alone', async () => {
    const { hub, frame } = fakeHub();
    const { result } = renderHook(() => useBoard(hub, 'forge', 'qb'));
    expect(pending[0]!.url).toBe('/api/nodes/forge/scouts/qb');
    act(() => pending[0]!.answer(board([item({ id: '1' })])));
    await waitFor(() => expect(result.current.board?.items).toHaveLength(1));
    act(() => frame({ kind: 'board-items', node: 'forge', scout: 'other', items: [item({ id: '1', state: 'done' })] }));
    act(() => frame({ kind: 'board-items', node: 'forge', scout: 'qb', items: [item({ id: '1', state: 'done' })] }));
    expect(result.current.board?.items[0]!.state).toBe('done');
    act(() => frame({ kind: 'board', node: 'forge', board: board([item({ id: '2' })]) }));
    expect(result.current.board?.items.map((i) => i.id)).toEqual(['2']);
  });

  it('lays frames heard while loading over the Board it loads', async () => {
    const { hub, frame } = fakeHub();
    const { result } = renderHook(() => useBoard(hub, 'forge', 'qb'));
    act(() => frame({ kind: 'board-items', node: 'forge', scout: 'qb', items: [item({ id: '1', state: 'done' })] }));
    act(() => pending[0]!.answer(board([item({ id: '1' }), item({ id: '2' })])));
    await waitFor(() => expect(result.current.board?.items.map((i) => i.state)).toEqual(['done', 'new']));
  });

  it('says why a Board didn’t load, apart from the hub not knowing it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'database is locked' }) })),
    );
    const { hub } = fakeHub();
    const { result } = renderHook(() => useBoard(hub, 'forge', 'qb'));
    await waitFor(() => expect(result.current.failed).toBe('database is locked'));
    expect(result.current.missing).toBe(false);
  });

  it('reads the Board again when the socket comes back', () => {
    const { hub, reconnect } = fakeHub();
    renderHook(() => useBoard(hub, 'forge', 'qb'));
    act(() => reconnect());
    expect(pending.map((p) => p.url)).toEqual(['/api/nodes/forge/scouts/qb', '/api/nodes/forge/scouts/qb']);
  });

  it('says when the hub doesn’t know the Scout', async () => {
    const { hub } = fakeHub();
    const { result } = renderHook(() => useBoard(hub, 'forge', 'qb'));
    act(() => pending[0]!.answer(undefined));
    await waitFor(() => expect(result.current.missing).toBe(true));
  });
});
