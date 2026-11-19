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
  const onQuest = vi.fn(async () => ({}));
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
      onQuest={onQuest}
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

  describe('the redesigned page', () => {
    const mail: ScoutManifest = {
      ...manifest,
      synthesize: { prompt: 'synthesize.md', when: 'now' },
      summary: [{ label: 'Unread', field: 'unread' }],
      show: { who: 'from', when: 'date', unread: 'unread', preview: 'body' },
    };
    const mailScout = (extra: Partial<ListedScout> = {}): ListedScout => ({
      id: 'quest-board',
      fresh: 0,
      manifest: mail,
      ...extra,
    });
    const today = new Date(NOW).toISOString();

    it('sums the Board up in a banner: open, new this visit, suggested, the Scout-s counts, and when Augury last ran', () => {
      show({
        scout: mailScout(),
        runs: [run({ startedAt: 0, finishedAt: 300_000, costUsd: 0.62 })],
        items: [
          item({ id: 'a', state: 'new', suggested: 'done', fields: { unread: true } }),
          item({ id: 'b', state: 'seen', fields: { unread: false } }),
          item({ id: 'c', state: 'done' }),
        ],
      });
      const banner = screen.getByRole('region', { name: 'Summary' });
      const tile = (label: string) =>
        within(banner).getByText(label, { selector: 'dt' }).nextElementSibling?.textContent;
      expect(tile('Open')).toBe('2');
      expect(tile('New')).toBe('1');
      expect(tile('Suggested')).toBe('1');
      expect(tile('Unread')).toBe('1');
      expect(tile('Augury')).toContain('5m ago');
    });

    it('draws a row as a mail list does: who, when, the title with a preview, unread in bold', () => {
      show({
        scout: mailScout(),
        items: [
          item({
            state: 'seen',
            title: 'Lunch on Friday?',
            fields: { from: 'Ada Lovelace', date: today, unread: true, body: 'Are you free at noon' },
          }),
        ],
      });
      const list = screen.getByRole('region', { name: 'Items' });
      const row = within(list).getByText('Ada Lovelace').closest('li')!;
      expect(row.getAttribute('data-unread')).toBe('true');
      expect(within(row).getByText('Lunch on Friday?')).toBeTruthy();
      expect(within(row).getByText(/Are you free at noon/)).toBeTruthy();
      expect(
        within(row).getByText(new Date(NOW).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })),
      ).toBeTruthy();
      // Unread is said in words too, not by weight alone.
      expect(within(row).getByText('Unread', { selector: '.sr-only' })).toBeTruthy();
      expect(within(row).getByText('A', { selector: '[data-avatar]' })).toBeTruthy();
      expect(within(row).getByText('Ada Lovelace').className).toMatch(/font-semibold/);
    });

    it('keeps a read message in plain weight, though it is new on this visit', () => {
      show({
        scout: mailScout(),
        items: [item({ state: 'new', title: 'Read already', fields: { from: 'Ada', date: today, unread: false } })],
      });
      expect(screen.getByText('Ada').className).not.toMatch(/font-semibold/);
    });

    it('gathers what Augury suggests in a pane beside the list, under each action, with its button', () => {
      const shown = show({
        scout: mailScout(),
        items: [
          item({
            id: 'a',
            state: 'seen',
            title: 'Weekly digest',
            rank: 2,
            actions: ['archive', 'done'],
            suggested: 'archive',
            summary: 'Nothing to do.',
          }),
          item({
            id: 'b',
            state: 'seen',
            title: 'Sale ends',
            rank: 3,
            actions: ['archive', 'done'],
            suggested: 'archive',
          }),
          item({ id: 'c', state: 'seen', title: 'Your invoice', rank: 1, actions: ['done'], suggested: 'done' }),
          item({ id: 'd', state: 'seen', title: 'Unranked' }),
        ],
      });
      const pane = screen.getByRole('region', { name: 'Counsel' });
      const groups = within(pane).getAllByRole('group');
      expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual(['Done', 'Archive']);
      expect(
        within(groups[1]!)
          .getAllByRole('listitem')
          .map((li) => li.textContent),
      ).toEqual([expect.stringContaining('Weekly digest'), expect.stringContaining('Sale ends')]);
      expect(within(groups[1]!).getByText('Nothing to do.')).toBeTruthy();
      expect(within(pane).queryByText('Unranked')).toBeNull();
      // One press for the whole group, asking first as the action says.
      fireEvent.click(within(groups[1]!).getByRole('button', { name: 'Archive all 2' }));
      fireEvent.click(within(groups[1]!).getByRole('button', { name: 'Yes, Archive all 2' }));
      expect(shown.onAct).toHaveBeenCalledWith('archive', ['a', 'b']);
    });

    it('keeps the subtitle when the Scout names a sender but no preview, and falls back to the title with no sender', () => {
      show({
        scout: mailScout({ manifest: { ...mail, show: { who: 'author' } } }),
        items: [
          item({
            id: 'a',
            state: 'seen',
            title: 'Fix the retry loop',
            subtitle: 'owner/repo#1 · waiting on others',
            fields: { author: 'ada' },
          }),
          item({ id: 'b', state: 'seen', title: 'No author here', subtitle: 'owner/repo#2' }),
        ],
      });
      const list = screen.getByRole('region', { name: 'Items' });
      const row = within(list).getByText('ada').closest('li')!;
      expect(within(row).getByText(/owner\/repo#1 · waiting on others/)).toBeTruthy();
      const bare = within(list).getByText('No author here').closest('li')!;
      expect(bare.querySelector('[data-avatar]')).toBeNull();
      expect(within(bare).getByText('owner/repo#2')).toBeTruthy();
    });

    it('lists newest first in a list, but leaves a table in rank order', () => {
      const dated = [
        item({
          id: 'old',
          state: 'seen',
          title: 'Older',
          rank: 1,
          group: undefined,
          fields: { date: '2026-11-01T00:00:00Z' },
        }),
        item({
          id: 'new',
          state: 'seen',
          title: 'Newer',
          rank: 2,
          group: undefined,
          fields: { date: '2026-11-17T00:00:00Z' },
        }),
      ];
      show({ scout: mailScout(), items: dated });
      const titles = () =>
        within(screen.getByRole('region', { name: 'Items' }))
          .getAllByText(/^(Older|Newer)$/)
          .map((node) => node.textContent);
      expect(titles()).toEqual(['Newer', 'Older']);
      cleanup();
      show({ scout: mailScout({ manifest: { ...mail, view: 'table' } }), items: dated });
      expect(titles()).toEqual(['Older', 'Newer']);
    });

    it('keeps the next run, a pause and a broken scout.json in the banner', () => {
      show({
        scout: mailScout({ nextRunAt: NOW + 3_600_000, paused: 'Failed 3 times in a row.', error: 'bad json' }),
      });
      const banner = screen.getByRole('region', { name: 'Summary' });
      expect(within(banner).getByText('Paused: Failed 3 times in a row.')).toBeTruthy();
      expect(within(banner).getByText(/bad json/)).toBeTruthy();
      expect(within(banner).getByRole('button', { name: 'Run now' })).toBeTruthy();
      cleanup();
      show({ scout: mailScout({ nextRunAt: NOW + 3_600_000 }) });
      expect(within(screen.getByRole('region', { name: 'Summary' })).getByText(/next /)).toBeTruthy();
      expect(
        within(screen.getByRole('region', { name: 'Summary' })).getByText('Augury', { selector: 'dt' })
          .nextElementSibling?.textContent,
      ).toBe('not yet');
    });

    it('leaves Counsel out for a Scout that neither synthesizes nor suggests, and the list takes the width', () => {
      const plain: ScoutManifest = { ...mail };
      delete plain.synthesize;
      show({ scout: mailScout({ manifest: plain }), items: [item({ state: 'seen' })] });
      expect(screen.queryByRole('region', { name: 'Counsel' })).toBeNull();
    });

    it('says who each suggestion is from, where the Scout names a sender', () => {
      show({
        scout: mailScout(),
        items: [
          item({
            state: 'seen',
            title: 'Lunch?',
            rank: 1,
            suggested: 'done',
            actions: ['done'],
            fields: { from: 'Ada' },
          }),
        ],
      });
      expect(within(screen.getByRole('region', { name: 'Counsel' })).getByText('Ada')).toBeTruthy();
    });

    it('keeps a row-s confirm in view after the pointer leaves', () => {
      show({ scout: mailScout(), items: [item({ state: 'seen', actions: ['archive'], fields: { from: 'Ada' } })] });
      const list = screen.getByRole('region', { name: 'Items' });
      fireEvent.click(within(list).getByRole('button', { name: 'Archive' }));
      const tools = within(list).getByRole('button', { name: 'Yes, Archive' }).closest('[data-row-tools]')!;
      expect(tools.querySelector('[data-asking]')).not.toBeNull();
      expect(tools.className).toMatch(/has-\[\[data-asking\]\]:opacity-100/);
    });

    describe('starting a Quest from Counsel', () => {
      const suggested = [
        item({ id: 'a', state: 'seen', title: 'Lunch?', rank: 1, actions: ['done'], suggested: 'done' }),
        item({ id: 'b', state: 'seen', title: 'Invoice', rank: 2, actions: ['done'], suggested: 'done' }),
      ];

      it('opens a composer over every suggestion, with an editable prompt, and starts the Quest', async () => {
        const onQuest = vi.fn(async () => ({ session: 'q1' }));
        const shown = show({ scout: mailScout(), items: suggested, onQuest });
        const pane = screen.getByRole('region', { name: 'Counsel' });
        fireEvent.click(within(pane).getByRole('button', { name: 'Start a Quest on all 2' }));
        const composer = screen.getByRole('form', { name: 'New Quest from this Board' });
        const prompt = within(composer).getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement;
        expect(prompt.value).toMatch(/these 2 items/);
        expect(within(composer).getByRole('textbox', { name: 'Folder' })).toHaveProperty('value', '~/code/repo');
        // Take one out, and say it another way.
        fireEvent.click(within(composer).getByRole('button', { name: 'Leave out Invoice' }));
        fireEvent.change(prompt, { target: { value: 'Draft a reply for me.' } });
        fireEvent.click(within(composer).getByRole('button', { name: 'Start Quest' }));
        await act(async () => {});
        expect(onQuest).toHaveBeenCalledWith({
          ids: ['a'],
          prompt: 'Draft a reply for me.',
          project: '~/code/repo',
          mode: 'auto',
        });
        expect(shown.onOpenQuest).toHaveBeenCalledWith('q1');
      });

      it('opens it for one item from that item-s own button, and shows why the Kingdom refused', async () => {
        const onQuest = vi.fn(async () => {
          throw new Error('update this Kingdom first: it is too old for this');
        });
        show({ scout: mailScout(), items: suggested, onQuest });
        const pane = screen.getByRole('region', { name: 'Counsel' });
        fireEvent.click(within(pane).getByRole('button', { name: 'Start a Quest on Invoice' }));
        const composer = screen.getByRole('form', { name: 'New Quest from this Board' });
        expect((within(composer).getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement).value).toMatch(
          /this item/,
        );
        expect(
          within(composer)
            .getAllByRole('listitem')
            .map((li) => li.textContent),
        ).toEqual([expect.stringContaining('Invoice')]);
        fireEvent.click(within(composer).getByRole('button', { name: 'Start Quest' }));
        expect(await within(composer).findByRole('alert')).toHaveProperty(
          'textContent',
          'update this Kingdom first: it is too old for this',
        );
        fireEvent.click(within(composer).getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByRole('form', { name: 'New Quest from this Board' })).toBeNull();
      });
    });

    it('says what fills the pane when nothing is suggested yet', () => {
      show({ scout: mailScout(), items: [item({ state: 'seen' })] });
      expect(within(screen.getByRole('region', { name: 'Counsel' })).getByText(/Run now asks Augury/)).toBeTruthy();
    });
  });

  it('highlights the action suggested for an item', () => {
    show({ items: [item({ state: 'seen', actions: ['fix', 'done'], suggested: 'fix' })] });
    const list = screen.getByRole('region', { name: 'Items' });
    expect(within(list).getByRole('button', { name: 'Fix it' }).getAttribute('title')).toBe('Suggested');
    expect(within(list).getByRole('button', { name: 'Done' }).getAttribute('title')).toBeNull();
  });

  it.each(['list', 'table'] as const)('shows the line summing an item up, in a %s', (view) => {
    show({
      scout: { id: 'quest-board', fresh: 0, manifest: { ...manifest, view } },
      items: [item({ state: 'seen', summary: 'CI fails on one runner; the fix looks small.' })],
    });
    const summary = screen.getByText('CI fails on one runner; the fix looks small.');
    // Clamped to two lines, with the whole text on hover.
    expect(summary.getAttribute('title')).toBe('CI fails on one runner; the fix looks small.');
    expect(summary.className).toMatch(/line-clamp-2/);
    // `block` comes later in the built CSS and would undo the clamp's display.
    expect(summary.classList.contains('block')).toBe(false);
  });

  it.each(['list', 'table'] as const)(
    'marks a summary the synthesis step wrote, naming it on hover, in a %s',
    (view) => {
      show({
        scout: { id: 'quest-board', fresh: 0, manifest: { ...manifest, view } },
        items: [
          item({ state: 'seen', rank: 1, rankSource: 'synthesis', summary: 'Small fix.', summarySource: 'synthesis' }),
          item({ id: '2', title: 'Answer the review', state: 'seen', rank: 2, summary: 'The collector wrote this.' }),
          item({
            id: 'synthesis:0123456789ab',
            title: 'Two PRs touch the uploader',
            state: 'seen',
            summary: 'Pair them.',
            summarySource: 'synthesis',
          }),
        ],
      });
      const note = 'Rank 1 · rank and summary from Augury (the synthesis step)';
      const marks = screen.getAllByRole('img', { name: /synthesis step/ });
      expect(marks.map((mark) => mark.getAttribute('title'))).toEqual([note, 'Written by Augury (the synthesis step)']);
      const row = (title: string) => screen.getByText(title).closest(view === 'list' ? 'li' : 'tr')!;
      expect(row('Fix the retry loop').getAttribute('title')).toBe(note);
      // The collector's own rank is on hover too, with no marker.
      expect(row('Answer the review').getAttribute('title')).toBe('Rank 2 · rank and summary from the collector');
      expect(within(row('Answer the review')).queryByRole('img')).toBeNull();
      // Hovering the title itself names the source too, not only the row's gaps.
      expect(screen.getByText('Fix the retry loop').getAttribute('title')).toBe(`Fix the retry loop\n${note}`);
    },
  );

  it('marks no summary the Board does not show, but still marks an extra row the step wrote', () => {
    show({
      items: [
        item({ state: 'seen', summary: '', summarySource: 'synthesis' }),
        item({
          id: 'synthesis:0123456789ab',
          title: 'Pair them',
          state: 'seen',
          summary: '',
          summarySource: 'synthesis',
        }),
      ],
    });
    const marks = screen.getAllByRole('img');
    expect(marks).toHaveLength(1);
    expect(marks[0]!.getAttribute('aria-label')).toBe('Written by Augury (the synthesis step)');
    expect(within(screen.getByText('Fix the retry loop').closest('li')!).queryByRole('img')).toBeNull();
  });

  it('keeps a failed run-s reason on its line, not as a warning', () => {
    show({ runs: [run({ outcome: 'failed', reason: 'the collector exited with code 3' })] });
    fireEvent.click(screen.getByText('Recent runs'));
    expect(screen.queryByText('the collector exited with code 3')).toBeNull();
    expect(screen.getByText(/· the collector exited with code 3/)).toBeTruthy();
  });

  it('sets a succeeded run-s note on a line of its own, as a warning', () => {
    show({ runs: [run({ reason: 'not synthesized: it reached its budget cap (synthesize.maxBudgetUsd)' })] });
    fireEvent.click(screen.getByText('Recent runs'));
    const note = screen.getByText('not synthesized: it reached its budget cap (synthesize.maxBudgetUsd)');
    expect(note.className).toMatch(/amber/);
  });

  it('says on Run now when a press is what asks the synthesis step, since that spends plan usage', () => {
    show({
      scout: {
        id: 'quest-board',
        fresh: 0,
        manifest: { ...manifest, synthesize: { prompt: 'synthesize.md', when: 'now' } },
      },
    });
    expect(screen.getByRole('button', { name: 'Run now' }).getAttribute('title')).toMatch(/synthesis step.*usage/);
  });

  it('pins or unpins its tab on this device', () => {
    const onPin = vi.fn();
    show({ pinned: true, onPin });
    fireEvent.click(screen.getByRole('button', { name: 'Unpin from tab strip' }));
    expect(onPin).toHaveBeenCalledWith(false);
    cleanup();
    show({ pinned: false, onPin });
    fireEvent.click(screen.getByRole('button', { name: 'Pin to tab strip' }));
    expect(onPin).toHaveBeenCalledWith(true);
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
