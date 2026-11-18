import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Board, BoardItem, ListedScout, ScoutManifest, ScoutRun } from '@crystal-bridge/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoardPage, type BoardPageProps } from './Board.js';

const manifest: ScoutManifest = {
  name: 'Quest Board',
  schedule: { cron: '*/15 8-20 * * 1-5', timezone: 'America/Chicago' },
  collect: { command: ['./collect.sh'] },
  view: 'list',
  actions: {
    open: { kind: 'link', label: 'Open', url: '{{url}}' },
    later: { kind: 'snooze', label: 'Later', for: '1d' },
    done: { kind: 'done', label: 'Done' },
    drop: { kind: 'dismiss', label: 'Not mine' },
    fix: { kind: 'quest', label: 'Fix it', project: '~/code/repo', prompt: 'fix.md' },
    archive: { kind: 'run', label: 'Archive', command: ['./act.sh'], batch: true, confirm: true },
  },
  defaults: ['open', 'later', 'done', 'drop'],
};

const item = (extra: Partial<BoardItem> = {}): BoardItem => ({
  id: '1',
  title: 'Fix the retry loop',
  subtitle: 'owner/repo · checks failing',
  url: 'https://github.com/owner/repo/pull/1',
  group: 'Needs a fix',
  state: 'new',
  firstSeen: 0,
  changedAt: 0,
  ...extra,
});

const run = (extra: Partial<ScoutRun> = {}): ScoutRun => ({
  id: '11111111-1111-4111-8111-111111111111',
  startedAt: 60_000,
  finishedAt: 64_000,
  trigger: 'schedule',
  outcome: 'succeeded',
  items: 2,
  ...extra,
});

const NOW = 600_000;

function show(props: Partial<BoardPageProps> & { items?: BoardItem[]; runs?: ScoutRun[] } = {}) {
  const { items = [item()], runs = [run()], ...rest } = props;
  const board: Board = { scout: 'quest-board', runs, items };
  const scout: ListedScout = { id: 'quest-board', fresh: 1, manifest, lastRun: runs[0] };
  const onChange = vi.fn(async () => {});
  const onRunNow = vi.fn(async () => {});
  const onAct = vi.fn(async (_action: string, _ids: string[]): Promise<{ session?: string }> => ({}));
  const onOpenQuest = vi.fn();
  const onBack = vi.fn();
  const view = render(
    <BoardPage
      kingdom="Forge"
      scout={scout}
      board={board}
      missing={false}
      now={NOW}
      onChange={onChange}
      onRunNow={onRunNow}
      onAct={onAct}
      onOpenQuest={onOpenQuest}
      onBack={onBack}
      {...rest}
    />,
  );
  return { ...view, onChange, onRunNow, onAct, onOpenQuest, onBack, board, scout };
}

describe('BoardPage', () => {
  afterEach(() => cleanup());

  it('lists open items under their groups, with the buttons each one offers', () => {
    show({ items: [item(), item({ id: '2', title: 'Answer the review', group: 'Waiting on you' })] });
    const groups = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(groups).toEqual(['Needs a fix', 'Waiting on you']);
    const row = screen.getByText('Fix the retry loop').closest('li')!;
    expect(within(row).getByText('owner/repo · checks failing')).toBeTruthy();
    const open = within(row).getByRole('link', { name: 'Open' });
    expect(open.getAttribute('href')).toBe('https://github.com/owner/repo/pull/1');
    expect(open.getAttribute('rel')).toContain('noopener');
    expect(
      within(row)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Later', 'Done', 'Not mine']);
  });

  it('marks what’s new as seen once, and keeps the mark for this visit', () => {
    const { onChange, rerender, scout, board } = show({
      items: [item(), item({ id: '2', title: 'Answer the review', state: 'seen' })],
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(['1'], 'seen');
    const seen: Board = {
      ...board,
      items: [item({ state: 'seen' }), item({ id: '2', title: 'Answer the review', state: 'seen' })],
    };
    rerender(
      <BoardPage
        kingdom="Forge"
        scout={scout}
        board={seen}
        missing={false}
        now={NOW}
        onChange={onChange}
        onRunNow={vi.fn()}
        onAct={vi.fn()}
        onOpenQuest={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(onChange).toHaveBeenCalledTimes(1);
    const row = screen.getByText('Fix the retry loop').closest('li')!;
    expect(within(row).getByText('New')).toBeTruthy();
  });

  it('snoozes for the action’s time, and marks done or dismissed', () => {
    const { onChange } = show({ items: [item({ state: 'seen' })] });
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(onChange).toHaveBeenLastCalledWith(['1'], 'snoozed', NOW + 86_400_000);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onChange).toHaveBeenLastCalledWith(['1'], 'done');
    fireEvent.click(screen.getByRole('button', { name: 'Not mine' }));
    expect(onChange).toHaveBeenLastCalledWith(['1'], 'dismissed');
  });

  it('folds away snoozed, set-aside and gone items, and can bring one back', () => {
    const { onChange } = show({
      items: [
        item({ id: 's', title: 'Snoozed one', state: 'snoozed', until: NOW + 60_000 }),
        item({ id: 'd', title: 'Done one', state: 'done' }),
        item({ id: 'g', title: 'Gone one', state: 'seen', goneAt: NOW - 1_000 }),
      ],
    });
    expect(screen.queryByText('Snoozed one')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Snoozed/ }));
    fireEvent.click(screen.getByRole('button', { name: /Set aside/ }));
    fireEvent.click(screen.getByRole('button', { name: /Gone lately/ }));
    expect(screen.getByText('Snoozed one')).toBeTruthy();
    expect(screen.getByText('Gone one')).toBeTruthy();
    const done = screen.getByText('Done one').closest('li')!;
    fireEvent.click(within(done).getByRole('button', { name: 'Bring back' }));
    expect(onChange).toHaveBeenLastCalledWith(['d'], 'new');
    const gone = screen.getByText('Gone one').closest('li')!;
    expect(within(gone).queryByRole('button')).toBeNull();
  });

  it('draws a checklist: checking an item marks it done, and unchecking brings it back', () => {
    const { onChange } = show({
      scout: { id: 'quest-board', fresh: 0, manifest: { ...manifest, view: 'checklist' } },
      items: [item({ state: 'seen' }), item({ id: '2', title: 'Pay the card', state: 'done' })],
    });
    const open = screen.getByRole('checkbox', { name: 'Fix the retry loop' }) as HTMLInputElement;
    expect(open.checked).toBe(false);
    fireEvent.click(open);
    expect(onChange).toHaveBeenLastCalledWith(['1'], 'done');
    const paid = screen.getByRole('checkbox', { name: 'Pay the card' }) as HTMLInputElement;
    expect(paid.checked).toBe(true);
    fireEvent.click(paid);
    expect(onChange).toHaveBeenLastCalledWith(['2'], 'new');
  });

  it('draws a table with a column per field', () => {
    show({
      scout: { id: 'quest-board', fresh: 0, manifest: { ...manifest, view: 'table' } },
      items: [item({ state: 'seen', fields: { repo: 'owner/repo', checks: 'failing', draft: false } })],
    });
    const table = screen.getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Item', 'repo', 'checks', 'draft', '']);
    expect(within(table).getByRole('cell', { name: 'failing' })).toBeTruthy();
    expect(within(table).getByRole('cell', { name: 'no' })).toBeTruthy();
  });

  it('starts the Quest an item offers, and opens it', async () => {
    const { onAct, onOpenQuest } = show({ items: [item({ state: 'seen', actions: ['fix', 'done'] })] });
    onAct.mockResolvedValueOnce({ session: 'quest-1' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Fix it' }));
    });
    expect(onAct).toHaveBeenCalledWith('fix', ['1']);
    expect(onOpenQuest).toHaveBeenCalledWith('quest-1');
  });

  it('shows why a Kingdom refused an action, and lets it be pressed again', async () => {
    const { onAct } = show({ items: [item({ state: 'seen', actions: ['fix'] })] });
    onAct.mockRejectedValueOnce(new Error('no such project folder: ~/code/repo'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Fix it' }));
    });
    expect(screen.getByRole('alert').textContent).toContain('no such project folder');
    expect((screen.getByRole('button', { name: 'Fix it' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('asks before an action that wants confirming, and runs it only on yes', async () => {
    const { onAct } = show({ items: [item({ state: 'seen', actions: ['archive'] })] });
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(onAct).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onAct).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Yes, Archive' }));
    });
    expect(onAct).toHaveBeenCalledWith('archive', ['1']);
  });

  it('offers a batch action once for a group, on every item in it that offers it', async () => {
    const { onAct } = show({
      items: [
        item({ state: 'seen', actions: ['archive'] }),
        item({ id: '2', state: 'seen', title: 'Second', actions: ['archive'] }),
      ],
    });
    const group = screen.getByRole('region', { name: 'Needs a fix' });
    fireEvent.click(within(group).getByRole('button', { name: 'Archive all 2' }));
    await act(async () => {
      fireEvent.click(within(group).getByRole('button', { name: 'Yes, Archive all 2' }));
    });
    expect(onAct).toHaveBeenCalledWith('archive', ['1', '2']);
  });

  it('highlights the action suggested for an item', () => {
    show({ items: [item({ state: 'seen', actions: ['fix', 'done'], suggested: 'fix' })] });
    expect(screen.getByRole('button', { name: 'Fix it' }).getAttribute('title')).toBe('Suggested');
    expect(screen.getByRole('button', { name: 'Done' }).getAttribute('title')).toBeNull();
  });

  it.each(['list', 'table'] as const)('shows the line summing an item up, in a %s', (view) => {
    show({
      scout: { id: 'quest-board', fresh: 0, manifest: { ...manifest, view } },
      items: [item({ state: 'seen', summary: 'CI fails on one runner; the fix looks small.' })],
    });
    const summary = screen.getByText('CI fails on one runner; the fix looks small.');
    // Clamped to two lines, with the whole text on hover.
    expect(summary.getAttribute('title')).toBe('CI fails on one runner; the fix looks small.');
  });

  it('sets a succeeded run-s note on a line of its own, as a warning', () => {
    show({ runs: [run({ reason: 'not synthesized: it reached its budget cap (synthesize.maxBudgetUsd)' })] });
    fireEvent.click(screen.getByText('Recent runs'));
    const note = screen.getByText('not synthesized: it reached its budget cap (synthesize.maxBudgetUsd)');
    expect(note.className).toMatch(/amber/);
  });

  it('runs the Scout now, and shows why the hub refused', async () => {
    const { onRunNow } = show();
    onRunNow.mockRejectedValueOnce(new Error('that Kingdom is offline'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    });
    expect(onRunNow).toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('that Kingdom is offline');
  });

  it('says what the last run brought back, and keeps the recent runs folded with how each went', () => {
    show({
      runs: [
        run(),
        run({
          id: '22222222-2222-4222-8222-222222222222',
          outcome: 'failed',
          reason: 'exit 1',
          stderr: 'gh: not logged in',
          items: undefined,
        }),
      ],
    });
    expect(screen.getByText('Your Scout returned with 2 findings.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Recent runs/ }));
    const rows = within(screen.getByRole('list', { name: 'Recent runs' })).getAllByRole('listitem');
    expect(rows[0]!.textContent).toMatch(/succeeded.*schedule.*4s.*2 items/);
    expect(rows[1]!.textContent).toMatch(/failed.*exit 1/);
    expect(screen.getByText('gh: not logged in').closest('details')).not.toBeNull();
    expect(screen.getByRole('button', { name: /Recent runs/ }).getAttribute('title')).not.toMatch(/Scout/);
  });

  it('says why a Scout is paused, and why its scout.json doesn’t load', () => {
    show({
      scout: {
        id: 'quest-board',
        fresh: 0,
        manifest,
        paused: 'Failed 3 times in a row. Run now to try again.',
        error: 'scout.json: schedule.timezone is required',
      },
    });
    const alerts = screen.getAllByRole('alert').map((a) => a.textContent);
    expect(alerts.some((a) => a?.includes('Failed 3 times in a row'))).toBe(true);
    expect(alerts.some((a) => a?.includes('schedule.timezone is required'))).toBe(true);
  });

  it('shows a Scout whose scout.json never loaded, by its id and its error', () => {
    show({ scout: { id: 'quest-board', fresh: 0, error: 'scout.json: not JSON' }, items: [], runs: [] });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('quest-board');
    expect(screen.getByRole('alert').textContent).toContain('not JSON');
    expect(screen.queryByRole('button', { name: 'Run now' })).toBeNull();
  });

  it('says it’s loading while a listed Scout’s Board is on its way, never that it’s empty', () => {
    show({ board: null });
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(screen.queryByText(/Nothing yet/)).toBeNull();
  });

  it('says why a Board didn’t load', () => {
    show({ board: null, failed: 'The hub answered 500' });
    expect(screen.getByRole('alert').textContent).toContain('The hub answered 500');
    expect(screen.queryByText(/Nothing yet/)).toBeNull();
  });

  it('marks an item seen again when it comes back as new during the visit', () => {
    const { onChange, rerender, scout, board } = show({ items: [item()] });
    const again = (state: BoardItem['state'], now = NOW, extra: Partial<BoardItem> = {}) =>
      rerender(
        <BoardPage
          kingdom="Forge"
          scout={scout}
          board={{ ...board, items: [item({ state, ...extra })] }}
          missing={false}
          now={now}
          onChange={onChange}
          onRunNow={vi.fn()}
          onAct={vi.fn()}
          onOpenQuest={vi.fn()}
          onBack={vi.fn()}
        />,
      );
    again('seen');
    again('dismissed');
    again('new');
    expect(onChange.mock.calls.filter((call) => (call as unknown[])[1] === 'seen')).toHaveLength(2);
    // A snooze that runs out while the Board is open is new too.
    again('snoozed', NOW, { until: NOW + 1_000 });
    again('snoozed', NOW + 2_000, { until: NOW + 1_000 });
    expect(onChange.mock.calls.filter((call) => (call as unknown[])[1] === 'seen')).toHaveLength(3);
  });

  it('says so when the hub doesn’t know the Scout, with a way back', () => {
    const { onBack } = show({ scout: undefined, board: null, missing: true });
    expect(screen.getByText(/No such Scout on Forge/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Back to/ }));
    expect(onBack).toHaveBeenCalled();
  });
});
