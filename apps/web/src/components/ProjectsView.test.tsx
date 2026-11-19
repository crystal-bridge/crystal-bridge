import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Board, BoardItem, ListedScout, ScoutManifest } from '@crystal-bridge/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    },
  },
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
});
