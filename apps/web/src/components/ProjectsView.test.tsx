import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Board, BoardItem, ListedScout, ScoutManifest } from '@crystal-bridge/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { labelColours } from '../theme/labelColours.js';
import { BoardPage, type BoardPageProps } from './Board.js';

const projects: NonNullable<ScoutManifest['projects']> = {
  kind: {
    field: 'kind',
    values: {
      pr: { icon: 'pull-request', tone: 'emerald', label: 'Open pull request' },
      draft: { icon: 'draft', tone: 'slate', label: 'Draft pull request' },
      issue: { icon: 'issue', tone: 'sky', label: 'Open issue' },
      bug: { icon: 'bug', tone: 'red', label: 'Bug' },
    },
  },
  marks: [
    {
      field: 'checks',
      values: {
        pass: { icon: 'check-circle', tone: 'emerald', label: 'Checks pass' },
        fail: { icon: 'x-circle', tone: 'red', label: 'Checks fail' },
        running: { icon: 'running', tone: 'amber', label: 'Checks running' },
      },
    },
    {
      field: 'review',
      values: {
        approved: { icon: 'seal-check', tone: 'emerald', label: 'Approved' },
        changes: { icon: 'changes', tone: 'orange', label: 'Changes asked for' },
        pending: { icon: 'hourglass', tone: 'amber', label: 'Review pending' },
      },
    },
  ],
  reasons: {
    field: 'reason',
    values: {
      review: { icon: 'eye', tone: 'violet', label: 'Review requested' },
      fail: { icon: 'x-circle', tone: 'red', label: 'Checks failing' },
      changes: { icon: 'changes', tone: 'orange', label: 'Changes requested' },
      reply: { icon: 'reply', tone: 'sky', label: 'Reply owed' },
      merge: { icon: 'merge', tone: 'emerald', label: 'Ready to merge' },
      next: { icon: 'flag', tone: 'sky', label: 'Up next', lane: 'queue' },
    },
  },
  queue: { priority: 'priority', due: 'due' },
  who: 'author',
  whoKey: 'login',
  when: 'updated',
  comments: 'comments',
  added: 'plus',
  removed: 'minus',
  mine: 'mine',
};

const manifest: ScoutManifest = {
  name: 'Code Board',
  schedule: { cron: '*/15 8-20 * * 1-5', timezone: 'America/Chicago' },
  collect: { command: ['./collect.sh'] },
  view: 'projects',
  projects,
  actions: {
    open: { kind: 'link', label: 'Open', url: '{{url}}' },
    later: { kind: 'snooze', label: 'Later', for: '1d' },
    done: { kind: 'done', label: 'Done' },
    fix: { kind: 'quest', label: 'Fix the checks', project: '~/code/lantern', prompt: 'fix.md' },
    review: { kind: 'quest', label: 'Review', project: '~/code/lantern', prompt: 'review.md' },
    triage: { kind: 'quest', label: 'Triage', project: '~/code/lantern', prompt: 'triage.md' },
  },
  defaults: ['open', 'later', 'done'],
};

const NOW = Date.parse('2026-03-10T12:00:00Z');
const HOUR = 3_600_000;

let n = 0;
const item = (project: string, fields: BoardItem['fields'] = {}, extra: Partial<BoardItem> = {}): BoardItem => {
  n += 1;
  return {
    id: `i${n}`,
    title: `Item ${n}`,
    url: `https://code.test/${project}/${n}`,
    state: 'seen',
    firstSeen: 0,
    changedAt: 0,
    project: { name: project },
    fields: { kind: 'issue', updated: NOW - n * HOUR, ...fields },
    ...extra,
  };
};

function show(props: Partial<BoardPageProps> & { items: BoardItem[]; withManifest?: ScoutManifest }) {
  const { items, withManifest = manifest, ...rest } = props;
  const board: Board = { scout: 'code-board', runs: [], items };
  const scout: ListedScout = { id: 'code-board', fresh: 0, manifest: withManifest };
  const onChange = vi.fn(async () => {});
  const onAct = vi.fn(async (_action: string, _ids: string[]): Promise<{ session?: string }> => ({}));
  const all: BoardPageProps = {
    kingdom: 'Forge',
    node: `node-${n}`,
    scout,
    board,
    missing: false,
    now: NOW,
    onChange,
    onRunNow: vi.fn(async () => {}),
    onAct,
    onOpenQuest: vi.fn(),
    onBack: vi.fn(),
    onQuest: vi.fn(async () => ({})),
    ...rest,
  };
  const view = render(<BoardPage {...all} />);
  return { ...view, onChange, onAct, props: all };
}

const sectionNames = () =>
  within(screen.getByRole('region', { name: 'Projects' }))
    .getAllByRole('heading', { level: 3 })
    .map((heading) => heading.textContent);

describe('ProjectsView', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('draws a section per project with its counts, Needs-you projects first', () => {
    show({
      items: [
        item('acme/quill', { kind: 'pr', updated: NOW - HOUR }),
        item('acme/lantern', { kind: 'pr', reason: 'fail', updated: NOW - 5 * HOUR }),
        item('acme/lantern', { kind: 'issue', updated: NOW - 6 * HOUR }),
        item('acme/tidepool', { kind: 'bug', updated: NOW - 2 * HOUR }),
      ],
    });
    expect(sectionNames()).toEqual(['acme/lantern', 'acme/quill', 'acme/tidepool']);
    const lantern = screen.getByRole('region', { name: 'acme/lantern' });
    expect(within(lantern).getByTitle('1 Open pull request')).toBeTruthy();
    expect(within(lantern).getByTitle('1 Open issue')).toBeTruthy();
  });

  it('draws a row’s kind icon, reason chip, labels, marks, comments, age and who', () => {
    show({
      items: [
        item(
          'acme/lantern',
          {
            kind: 'pr',
            reason: 'review',
            checks: 'fail',
            review: 'pending',
            comments: 4,
            plus: 84,
            minus: 12,
            author: 'Mira Vale',
            login: 'mira',
            updated: NOW - 3 * HOUR,
          },
          {
            title: 'Fix the focus trap',
            labels: [
              { name: 'bug', color: '#d73a4a' },
              { name: 'good first issue', color: '#7057ff' },
            ],
          },
        ),
      ],
    });
    const projectsList = screen.getByRole('region', { name: 'Projects' });
    const row = within(projectsList).getByText('Fix the focus trap').closest('li')!;
    expect(within(row).getByRole('img', { name: 'Open pull request' })).toBeTruthy();
    expect(within(row).getByText('Review requested')).toBeTruthy();
    expect(within(row).getByText('bug')).toBeTruthy();
    expect(within(row).getByText('good first issue')).toBeTruthy();
    expect(within(row).getByTitle('Checks fail')).toBeTruthy();
    expect(within(row).getByTitle('Review pending')).toBeTruthy();
    expect(within(row).getByTitle('4 comments').textContent).toContain('4');
    expect(within(row).getByText('+84')).toBeTruthy();
    expect(within(row).getByText('−12')).toBeTruthy();
    expect(within(row).getByText('3h')).toBeTruthy();
    expect(within(row).getByTitle('Mira Vale').textContent).toBe('M');
  });

  it('marks your own items', () => {
    show({
      items: [
        item('acme/lantern', { mine: true }, { title: 'Saved searches' }),
        item('acme/lantern', {}, { title: 'Dark mode' }),
      ],
    });
    expect(screen.getByText('Saved searches').closest('li')!.hasAttribute('data-mine')).toBe(true);
    expect(screen.getByText('Dark mode').closest('li')!.hasAttribute('data-mine')).toBe(false);
  });

  it('folds a section and remembers it', () => {
    const items = [item('acme/lantern', {}, { title: 'Crash on empty config' }), item('acme/quill')];
    const { unmount, props } = show({ items, node: 'fold-node' });
    fireEvent.click(screen.getByRole('button', { name: 'Fold acme/lantern' }));
    expect(screen.queryByText('Crash on empty config')).toBeNull();
    unmount();
    render(<BoardPage {...props} />);
    expect(screen.queryByText('Crash on empty config')).toBeNull();
    expect(screen.getByRole('button', { name: 'Unfold acme/lantern' }).getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Unfold acme/lantern' }));
    expect(screen.getByText('Crash on empty config')).toBeTruthy();
  });

  it('shows eight rows and "Show 3 more"', () => {
    const items = Array.from({ length: 11 }, (_, at) => item('acme/lantern', {}, { title: `Row ${at + 1}` }));
    show({ items });
    const section = screen.getByRole('region', { name: 'acme/lantern' });
    expect(within(section).getAllByRole('listitem')).toHaveLength(8);
    fireEvent.click(within(section).getByRole('button', { name: 'Show 3 more' }));
    expect(within(section).getAllByRole('listitem')).toHaveLength(11);
    expect(within(section).getByText('Row 11')).toBeTruthy();
  });

  it('puts items with a reason in the Needs-you window, with the summary and the suggested action’s button', () => {
    const failing = item(
      'acme/lantern',
      { kind: 'pr', reason: 'fail' },
      {
        title: 'Stream logs over SSE',
        summary: 'The reconnect test fails since yesterday.',
        suggested: 'fix',
        actions: ['fix', 'open', 'later', 'done'],
      },
    );
    const { onAct, onChange } = show({ items: [failing, item('acme/quill', {}, { title: 'Quiet one' })] });
    const window = screen.getByRole('region', { name: 'Needs you' });
    expect(within(window).queryByText('Quiet one')).toBeNull();
    const card = within(window).getByText('Stream logs over SSE').closest('article')!;
    expect(within(card).getByText('Checks failing')).toBeTruthy();
    expect(within(card).getByText('acme/lantern')).toBeTruthy();
    expect(within(card).getByText('The reconnect test fails since yesterday.')).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe(failing.url);
    expect(
      within(card)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Fix the checks', 'Later']);
    expect(within(window).getByRole('button', { name: /on all 1/ })).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Fix the checks' }));
    expect(onAct).toHaveBeenCalledWith('fix', [failing.id]);
    fireEvent.click(within(card).getByRole('button', { name: 'Later' }));
    expect(onChange).toHaveBeenLastCalledWith([failing.id], 'snoozed', NOW + 86_400_000);
  });

  it("draws a Needs-you card's kind icon in its chip's colour, not slate", () => {
    show({
      items: [item('acme/lantern', { kind: 'pr', reason: 'fail' }, { title: 'Stream logs over SSE' })],
    });
    const card = within(screen.getByRole('region', { name: 'Needs you' }))
      .getByText('Stream logs over SSE')
      .closest('article')!;
    const icon = within(card).getByRole('img', { name: 'Open pull request' });
    expect(icon.className).not.toMatch(/text-slate-/);
    expect(icon.parentElement!.className).toMatch(/text-emerald-/);
  });

  it("draws a section's health bar: failing first, then each listed kind, then the rest", () => {
    show({
      items: [
        item('acme/lantern', { kind: 'issue', checks: 'fail' }),
        item('acme/lantern', { kind: 'pr' }),
        item('acme/lantern', { kind: 'mystery' }),
      ],
    });
    const bar = screen.getByRole('img', { name: '1 failing · 1 Open pull request · 1 other' });
    expect(bar.getAttribute('title')).toBe('1 failing · 1 Open pull request · 1 other');
    const segments = [...bar.children] as HTMLElement[];
    expect(segments).toHaveLength(3);
    expect(segments[0]!.className).toMatch(/text-red-/);
    expect(segments[1]!.className).toMatch(/text-emerald-/);
    expect(segments.map((segment) => segment.style.width)).toEqual(Array(3).fill('33.33333333333333%'));
  });

  it('sets a label pill’s text colours for both themes from its colour', () => {
    show({ items: [item('acme/lantern', {}, { title: 'Pale', labels: [{ name: 'docs', color: '#fef2c0' }] })] });
    const pill = screen.getByText('docs');
    expect(pill.style.getPropertyValue('--fg-light')).toBe(labelColours('#fef2c0').light);
    expect(pill.style.getPropertyValue('--fg-dark')).toBe(labelColours('#fef2c0').dark);
    expect(pill.className).toContain('text-[var(--fg-light)]');
  });

  it('keeps the folded Snoozed, Set aside and Gone sections', () => {
    show({
      items: [
        item('acme/lantern'),
        item('acme/lantern', {}, { title: 'Snoozed one', state: 'snoozed', until: NOW + 60_000 }),
        item('acme/lantern', {}, { title: 'Done one', state: 'done' }),
        item('acme/lantern', {}, { title: 'Gone one', goneAt: NOW - 1_000 }),
      ],
    });
    expect(screen.queryByText('Snoozed one')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Snoozed/ }));
    fireEvent.click(screen.getByRole('button', { name: /Set aside/ }));
    fireEvent.click(screen.getByRole('button', { name: /Gone lately/ }));
    expect(screen.getByText('Snoozed one')).toBeTruthy();
    expect(screen.getByText('Done one')).toBeTruthy();
    expect(screen.getByText('Gone one')).toBeTruthy();
  });

  it('falls back to the list when the manifest has no projects block', () => {
    const { projects: _dropped, ...plain } = manifest;
    show({ withManifest: plain, items: [item('acme/lantern', {}, { title: 'Plain row' })] });
    expect(screen.queryByRole('region', { name: 'Projects' })).toBeNull();
    expect(screen.getByText('Plain row').closest('li')).toBeTruthy();
  });
  it('marks the chosen layout in a neutral shade, since window blue means something needs you', () => {
    show({ items: [item('acme/lantern')] });
    const layout = screen.getByRole('radiogroup', { name: 'Layout' });
    for (const radio of within(layout).getAllByRole('radio')) {
      expect(radio.closest('label')?.className).not.toMatch(/window/);
    }
  });
  it('offers Projects and Tiles, Projects first', () => {
    show({ items: [item('acme/lantern')] });
    const layout = screen.getByRole('radiogroup', { name: 'Layout' });
    const radios = within(layout).getAllByRole('radio');
    expect(radios.map((radio) => radio.closest('label')?.textContent)).toEqual(['Projects', 'Tiles']);
    expect((within(layout).getByRole('radio', { name: 'Projects' }) as HTMLInputElement).checked).toBe(true);
    expect((within(layout).getByRole('radio', { name: 'Tiles' }) as HTMLInputElement).checked).toBe(false);
    cleanup();
    const { projects: _dropped, ...plain } = manifest;
    show({ withManifest: plain, items: [item('acme/lantern')] });
    expect(screen.queryByRole('radiogroup', { name: 'Layout' })).toBeNull();
    cleanup();
    show({ withManifest: { ...manifest, view: 'list' }, items: [item('acme/lantern')] });
    expect(screen.queryByRole('radiogroup', { name: 'Layout' })).toBeNull();
  });

  it('Tiles draws a tile per project with its counts, activity and top four items, reasons first', () => {
    const withSummary: ScoutManifest = {
      ...manifest,
      summary: [
        { label: 'Open PRs', field: 'isPr', icon: 'pull-request', tone: 'emerald' },
        { label: 'Failing', field: 'failing', icon: 'x-circle', tone: 'red' },
      ],
    };
    show({
      withManifest: withSummary,
      items: [
        item(
          'acme/lantern',
          { kind: 'pr', isPr: true, checks: 'pass' },
          { title: 'Saved searches', project: { name: 'acme/lantern', url: 'https://code.test/acme/lantern' } },
        ),
        item('acme/lantern', { kind: 'pr', isPr: true }, { title: 'Bump the bundler' }),
        item('acme/lantern', { kind: 'issue' }, { title: 'Dark mode' }),
        item('acme/lantern', { kind: 'issue' }, { title: 'Retention docs' }),
        item('acme/lantern', { kind: 'issue', reason: 'reply', checks: 'fail' }, { title: 'Crash on empty config' }),
        item(
          'acme/lantern',
          { kind: 'pr', isPr: true, failing: true, reason: 'fail', checks: 'fail' },
          { title: 'Stream logs over SSE' },
        ),
        item('acme/quill', { kind: 'pr', isPr: true }, { title: 'Windows paths' }),
      ],
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Tiles' }));
    expect(screen.queryByRole('region', { name: 'Projects' })).toBeNull();
    const tiles = screen.getByRole('region', { name: 'Tiles' });
    const lantern = within(tiles).getByRole('article', { name: 'acme/lantern' });
    expect(within(tiles).getByRole('article', { name: 'acme/quill' })).toBeTruthy();
    expect(within(lantern).getByRole('link', { name: 'acme/lantern' }).getAttribute('href')).toBe(
      'https://code.test/acme/lantern',
    );
    expect([...lantern.querySelectorAll('[data-stat]')].map((stat) => stat.getAttribute('title'))).toEqual([
      '2 Needs you',
      '3 Open PRs',
      '1 Failing',
    ]);
    const spark = within(lantern).getByRole('img', { name: /^Activity, last 14 days/ });
    expect(spark.getAttribute('aria-label')).toContain('6 in all');
    expect(spark.querySelectorAll('[data-bar]')).toHaveLength(14);
    const lines = within(within(lantern).getByRole('list')).getAllByRole('listitem');
    expect(lines.map((line) => line.textContent)).toEqual([
      'Stream logs over SSE',
      'Crash on empty config',
      'Saved searches',
      'Bump the bundler',
    ]);
    expect(within(lines[0]!).getByRole('img', { name: 'Checks failing' })).toBeTruthy();
    expect(within(lines[0]!).getByRole('img', { name: 'Checks fail' })).toBeTruthy();
    expect(within(lines[0]!).getByRole('img', { name: 'Open pull request' })).toBeTruthy();
    expect(within(lines[2]!).getByRole('img', { name: 'Checks pass' })).toBeTruthy();
    expect(within(lantern).getByRole('button', { name: 'Open all 6' })).toBeTruthy();
  });

  it('Tiles puts the Needs-you cards in a strip above', () => {
    show({
      items: [
        item('acme/lantern', { kind: 'pr', reason: 'fail' }, { title: 'Stream logs over SSE' }),
        item('acme/quill', {}, { title: 'Quiet one' }),
      ],
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Tiles' }));
    const strip = screen.getByRole('region', { name: 'Needs you' });
    const tiles = screen.getByRole('region', { name: 'Tiles' });
    expect(strip.compareDocumentPosition(tiles) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(strip).getByText('Stream logs over SSE').closest('article')).toBeTruthy();
    expect(within(strip).queryByText('Quiet one')).toBeNull();
    expect(within(strip).getByRole('button', { name: /on all 1/ })).toBeTruthy();
  });

  it('a tile opens Projects mode at its section', () => {
    const many = Array.from({ length: 10 }, (_, at) => item('acme/quill', {}, { title: `Quill ${at + 1}` }));
    show({ items: [item('acme/lantern', { reason: 'fail' }), ...many] });
    fireEvent.click(screen.getByRole('radio', { name: 'Tiles' }));
    const quill = screen.getByRole('article', { name: 'acme/quill' });
    fireEvent.click(within(quill).getByRole('button', { name: 'Open all 10' }));
    expect((screen.getByRole('radio', { name: 'Projects' }) as HTMLInputElement).checked).toBe(true);
    const section = screen.getByRole('region', { name: 'acme/quill' });
    expect(document.activeElement).toBe(section);
    // Open all means all: the section shows every row.
    expect(within(section).getAllByRole('listitem')).toHaveLength(10);
  });

  it('remembers the mode for this Board on this device', () => {
    const { unmount, props } = show({ items: [item('acme/lantern')], node: 'mode-node' });
    fireEvent.click(screen.getByRole('radio', { name: 'Tiles' }));
    unmount();
    render(<BoardPage {...props} />);
    expect((screen.getByRole('radio', { name: 'Tiles' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('region', { name: 'Tiles' })).toBeTruthy();
  });

  it('keeps the folded sections in Tiles mode', () => {
    show({
      items: [item('acme/lantern'), item('acme/lantern', {}, { title: 'Done one', state: 'done' })],
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Tiles' }));
    fireEvent.click(screen.getByRole('button', { name: /Set aside/ }));
    expect(screen.getByText('Done one')).toBeTruthy();
  });

  describe('the queue window', () => {
    const DAY = 86_400_000;
    const queued = () => [
      item('acme/lantern', { reason: 'next' }, { title: 'No priority' }),
      item('acme/quill', { reason: 'next', priority: 2, due: new Date(NOW - 2 * DAY).toISOString() }, { title: 'P2' }),
      item(
        'acme/lantern',
        { reason: 'next', priority: 0, due: new Date(NOW + 3 * DAY + HOUR).toISOString() },
        {
          title: 'P0',
          summary: 'Ship it before the release.',
          suggested: 'triage',
          actions: ['triage', 'open', 'later'],
        },
      ),
      item('acme/lantern', { reason: 'next', priority: '1' }, { title: 'P1' }),
    ];

    it('lists queue-lane items in order with their priority and due, apart from Needs you', () => {
      const { onAct } = show({
        items: [...queued(), item('acme/tidepool', { kind: 'pr', reason: 'fail' }, { title: 'Failing one' })],
      });
      const queue = screen.getByRole('region', { name: 'Your queue' });
      const cards = within(queue).getAllByRole('article');
      expect(cards.map((card) => card.querySelector('[data-title]')?.textContent)).toEqual([
        'P0',
        'P1',
        'P2',
        'No priority',
      ]);
      expect(within(queue).getByText('4')).toBeTruthy();
      const p0 = cards[0]!;
      expect(within(p0).getByText('Up next')).toBeTruthy();
      expect(within(p0).getByText('acme/lantern')).toBeTruthy();
      expect(within(p0).getByText('Ship it before the release.')).toBeTruthy();
      expect(within(p0).getByTitle('Priority 0').textContent).toBe('P0');
      expect(within(p0).getByTitle('Priority 0').className).toMatch(/red/);
      expect(within(p0).getByText('due in 3d')).toBeTruthy();
      expect(within(cards[1]!).getByTitle('Priority 1').className).toMatch(/orange/);
      expect(within(cards[2]!).getByText('overdue 2d')).toBeTruthy();
      expect(cards[3]!.querySelector('[title^="Priority"]')).toBeNull();
      expect(
        within(p0)
          .getAllByRole('button')
          .map((b) => b.textContent),
      ).toEqual(['Triage', 'Later']);
      expect(within(p0).getByRole('link', { name: 'Open' })).toBeTruthy();
      fireEvent.click(within(p0).getByRole('button', { name: 'Triage' }));
      expect(onAct).toHaveBeenCalledWith('triage', [expect.any(String)]);
      // A neutral panel: a blue window means someone is waiting on you.
      expect(queue.className).not.toMatch(/window/);

      const needs = screen.getByRole('region', { name: 'Needs you' });
      expect(within(needs).getAllByRole('article')).toHaveLength(1);
      expect(within(needs).queryByText('P0')).toBeNull();
      expect(needs.compareDocumentPosition(queue) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('leaves Needs you empty when only queue items are open, and still shows their reason in sections', () => {
      show({ items: queued() });
      expect(within(screen.getByRole('region', { name: 'Needs you' })).getByText('Nothing needs you right now.'));
      const lantern = screen.getByRole('region', { name: 'acme/lantern' });
      expect(within(lantern).getAllByText('Up next').length).toBeGreaterThan(0);
    });

    it('is absent when nothing is queued, and takes its title from the manifest', () => {
      show({ items: [item('acme/lantern', { reason: 'fail' })] });
      expect(screen.queryByRole('region', { name: 'Your queue' })).toBeNull();
      cleanup();
      show({
        withManifest: { ...manifest, projects: { ...projects, queue: { ...projects.queue, title: 'On deck' } } },
        items: queued(),
      });
      expect(screen.getByRole('region', { name: 'On deck' })).toBeTruthy();
    });

    it('shows eight and "Show N more"', () => {
      show({
        items: Array.from({ length: 11 }, (_, at) => item('acme/lantern', { reason: 'next' }, { title: `Q${at}` })),
      });
      const queue = screen.getByRole('region', { name: 'Your queue' });
      expect(within(queue).getAllByRole('article')).toHaveLength(8);
      fireEvent.click(within(queue).getByRole('button', { name: 'Show 3 more' }));
      expect(within(queue).getAllByRole('article')).toHaveLength(11);
    });

    it('Tiles shows the queue as a second strip under Needs you', () => {
      show({ items: [...queued(), item('acme/tidepool', { reason: 'fail' }, { title: 'Failing one' })] });
      fireEvent.click(screen.getByRole('radio', { name: 'Tiles' }));
      const needs = screen.getByRole('region', { name: 'Needs you' });
      const queue = screen.getByRole('region', { name: 'Your queue' });
      const tiles = screen.getByRole('region', { name: 'Tiles' });
      expect(needs.compareDocumentPosition(queue) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(queue.compareDocumentPosition(tiles) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(within(queue).getAllByRole('article')).toHaveLength(4);
      expect(within(needs).getAllByRole('article')).toHaveLength(1);
    });

    it('keeps everything in Needs you for an older manifest without lanes', () => {
      const values = Object.fromEntries(
        Object.entries(projects.reasons!.values).map(([key, { lane: _lane, ...look }]) => [key, look]),
      );
      const { queue: _queue, ...older } = { ...projects, reasons: { field: 'reason', values } };
      show({ withManifest: { ...manifest, projects: older }, items: queued() });
      expect(screen.queryByRole('region', { name: 'Your queue' })).toBeNull();
      expect(within(screen.getByRole('region', { name: 'Needs you' })).getAllByRole('article')).toHaveLength(4);
    });
  });
});
