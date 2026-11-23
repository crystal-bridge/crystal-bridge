import type { Deed, Envelope, ListedPatrol } from '@crystal-bridge/protocol';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayLabel, type DeedsState } from '../deeds.js';
import { w } from '../theme/words.js';
import { DeedsFeed, QuestDeeds } from './Deeds.js';
import type { SessionSummary } from './SessionList.js';

// A Friday, local evening.
const NOW = new Date(2026, 10, 20, 21, 40).getTime();
const at = (daysBack: number, hour: number, minute: number) =>
  new Date(2026, 10, 20 - daysBack, hour, minute).getTime();
const MINUTE = 60_000;

const CROWN = '11111111-1111-4111-8111-111111111111';
const SIEGE = '22222222-2222-4222-8222-222222222222';
const LOGIN = '33333333-3333-4333-8333-333333333333';
const DAWN = '44444444-4444-4444-8444-444444444444';
const LANTERN = '/r/acme/lantern';
const QUARRY = '/r/acme/quarry';

const row = (id: string, when: number, extra: Partial<Deed>): Deed => ({ id, kind: 'turn', at: when, ...extra });
const turn = (session: string, seq: number, when: number, extra: Partial<Deed>): Deed =>
  row(`turn:${session}:${seq}`, when, { session, seq, project: LANTERN, ...extra });

const ROWS: Deed[] = [
  // Today: a closed Quest with a turn Deed, two from Close and four turns.
  turn(CROWN, 1, at(0, 15, 2), {
    text: 'Reading the release checklist first.',
    files: 0,
    costUsd: 0.59,
    durationMs: 5 * MINUTE,
  }),
  turn(CROWN, 2, at(0, 16, 30), {
    text: 'The tab badge counted dismissed Errands.',
    files: 3,
    costUsd: 0.3,
    durationMs: 10 * MINUTE,
  }),
  turn(CROWN, 3, at(0, 17, 20), {
    text: 'Docs: the Errands guide is written.',
    files: 4,
    prs: ['https://github.com/acme/lantern/pull/319'],
    costUsd: 0.4,
    durationMs: 12 * MINUTE,
  }),
  row('deed:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', at(0, 17, 21), {
    kind: 'deed',
    session: CROWN,
    project: LANTERN,
    text: 'Fixed the tab badge counting dismissed Errands',
    detail: 'See https://example.com for the notes',
  }),
  turn(CROWN, 4, at(0, 18, 40), {
    text: 'Closing summary: v0.8.1 is tagged and the release notes are up.',
    files: 5,
    costUsd: 0.5,
    durationMs: 15 * MINUTE,
  }),
  row('deed:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', at(0, 18, 41), {
    kind: 'closing',
    session: CROWN,
    project: LANTERN,
    text: 'Released v0.8.1 with the Errands panel',
  }),
  row('deed:cccccccc-cccc-4ccc-8ccc-cccccccccccc', at(0, 18, 41) + 1, {
    kind: 'closing',
    session: CROWN,
    project: LANTERN,
    text: '<img src=x onerror=alert(1)>',
  }),
  row(`close:${CROWN}:9`, at(0, 18, 41) + 2, {
    kind: 'close',
    session: CROWN,
    project: LANTERN,
    outcome: 'recorded',
    costUsd: 0.05,
  }),
  // Today: an open Quest with three turns only.
  turn(SIEGE, 1, at(0, 13, 58), {
    text: 'Reading scripts/smoke.ts first.',
    files: 3,
    costUsd: 0.27,
    durationMs: 7 * MINUTE,
  }),
  turn(SIEGE, 2, at(0, 14, 20), {
    text: 'Step 7 fails in about one run in five.',
    files: 4,
    costUsd: 0.61,
    durationMs: 14 * MINUTE,
  }),
  turn(SIEGE, 3, at(0, 14, 52), {
    text: 'Found it: the hub answered before the socket was registered.',
    files: 5,
    costUsd: 0.96,
    durationMs: 21 * MINUTE,
  }),
  // Yesterday: a Quest that never named itself, whose call at Close took too long.
  turn(LOGIN, 1, at(1, 11, 12), {
    project: QUARRY,
    text: 'Rate limiting is on.',
    files: 2,
    costUsd: 0.21,
    durationMs: 5 * MINUTE,
  }),
  row(`close:${LOGIN}:2`, at(1, 11, 30), { kind: 'close', session: LOGIN, project: QUARRY, outcome: 'timeout' }),
  // Yesterday: a Patrol's Quest, closed without the call, and a script run that finished.
  turn(DAWN, 1, at(1, 6, 4), {
    project: QUARRY,
    patrol: 'dawn-audit',
    text: 'Two packages are two majors behind.',
    costUsd: 0.31,
    durationMs: 4 * MINUTE,
  }),
  row('run:run-1', at(1, 3, 0), {
    kind: 'patrol',
    patrol: 'backup',
    text: 'Backed up 4 repos to the vault: 412 MB.',
    outcome: 'finished',
    durationMs: 72_000,
  }),
  // Three days back: a script run that failed.
  row('run:run-2', at(3, 3, 0), {
    kind: 'patrol',
    patrol: 'backup',
    text: 'Backup failed: the vault did not answer within 30 s.',
    outcome: 'failed',
    durationMs: 31_000,
  }),
];

const session = (id: string, label: string, status: SessionSummary['status']): SessionSummary => ({
  id,
  node: 'node-a',
  cwd: LANTERN,
  label,
  status,
  createdAt: NOW - 600 * MINUTE,
});
const SESSIONS = [
  session(CROWN, 'The Coronation of v0.8.1', 'closed'),
  session(SIEGE, 'The Siege of the Flaky Smoke Test', 'idle'),
  session(LOGIN, 'Add rate limiting to the', 'closed'),
  session(DAWN, 'Dawn audit', 'closed'),
];
const patrol = (id: string, name: string): ListedPatrol =>
  ({
    id,
    manifest: { name, schedule: { cron: '0 3 * * *', timezone: 'UTC' } },
    failures: 0,
  }) as unknown as ListedPatrol;
const PATROLS = [patrol('backup', 'Nightly backup'), patrol('dawn-audit', 'Dawn audit')];

const LOADED: DeedsState = { deeds: ROWS, loaded: true };

function feed(extra: Partial<Parameters<typeof DeedsFeed>[0]> = {}) {
  const props = {
    state: LOADED,
    sessions: SESSIONS,
    patrols: PATROLS,
    now: NOW,
    onProject: vi.fn(),
    onOpenQuest: vi.fn(),
    onOpenRun: vi.fn(),
    onLoadOlder: vi.fn(),
    ...extra,
  };
  const view = render(<DeedsFeed {...props} />);
  return { ...props, view, region: screen.getByRole('region', { name: w('deedsFeed') }) };
}

const entry = (region: HTMLElement, name: string) => within(region).getByRole('listitem', { name });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DeedsFeed', () => {
  it('lists the days on a gold rail, newest first', () => {
    const { region } = feed();
    expect(within(region).getByRole('heading', { level: 2, name: w('deedsFeed') })).toBeTruthy();
    const days = within(region)
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(days).toEqual(['Today', 'Yesterday', dayLabel(new Date(2026, 10, 17).getTime(), NOW)]);
    expect(region.querySelector('[data-rail]')!.className).toContain('from-amber-300');
    for (const item of region.querySelectorAll('[data-entry]')) {
      expect(item.querySelector('[data-rail-tile]')!.getAttribute('title')).toBeTruthy();
    }
    const crown = entry(region, 'The Coronation of v0.8.1');
    expect(crown.querySelector('[data-rail-tile]')!.getAttribute('title')).toBe('Summed up at close');
    expect(crown.querySelector('[data-rail-tile] .cb-icon-deedClosing')).toBeTruthy();
  });

  it('shows a Quest’s Deeds as its lines, Close’s marked apart, with its turns folded into one line of totals', () => {
    const { region } = feed();
    const crown = entry(region, 'The Coronation of v0.8.1');
    const lines = [...crown.querySelectorAll('[data-deed]')];
    expect(lines.map((l) => l.querySelector('[data-deed-text]')!.textContent)).toEqual([
      '<img src=x onerror=alert(1)>',
      'Released v0.8.1 with the Errands panel',
      'Fixed the tab badge counting dismissed Errands',
    ]);
    expect(lines[0]!.querySelector('[title="From Close"] .cb-icon-deedClosing')).toBeTruthy();
    expect(lines[1]!.querySelector('[title="From Close"] .cb-icon-deedClosing')).toBeTruthy();
    expect(lines[2]!.querySelector('.cb-icon-quillInk')).toBeTruthy();
    expect(lines[2]!.querySelector('[title="From Close"]')).toBeNull();

    const details = crown.querySelector('details')!;
    const summary = details.querySelector('summary')!;
    expect(summary.textContent).toContain('The Coronation of v0.8.1');
    expect(summary.textContent).toContain('Closed with Deeds');
    expect(summary.textContent).toContain('4 turns · 12 files · PR #319 · $1.84 · 42m');
    expect(details.open).toBe(false);
    fireEvent.click(summary);
    expect(details.open).toBe(true);
    const turns = within(details).getAllByRole('listitem');
    expect(turns).toHaveLength(4);
    expect(turns[0]!.textContent).toContain('18:40');
    expect(turns[0]!.textContent).toContain('5 files');
    expect(turns[0]!.textContent).toContain('Closing summary: v0.8.1 is tagged');
    expect(turns[1]!.textContent).toContain('PR #319');
  });

  it('shows a Quest with only turn records as one line with the latest reply beneath', () => {
    const { region } = feed();
    const siege = entry(region, 'The Siege of the Flaky Smoke Test');
    const summary = siege.querySelector('summary')!;
    expect(summary.textContent).toContain('The Siege of the Flaky Smoke Test');
    expect(summary.textContent).toContain('3 turns · 12 files · $1.84 · 42m');
    const reply = within(summary).getByText(/Found it: the hub answered/);
    expect(reply.className).toContain('text-neutral-500');
    expect(siege.querySelector('[data-deed]')).toBeNull();
    fireEvent.click(summary);
    expect(within(siege.querySelector('details')!).getAllByRole('listitem')).toHaveLength(3);
    // Never named, so its label: the first words of its prompt.
    expect(entry(region, 'Add rate limiting to the')).toBeTruthy();
  });

  it('marks each Quest’s standing, saying why there are no Deeds', () => {
    const { region } = feed();
    expect(within(entry(region, 'The Siege of the Flaky Smoke Test')).getByText('Still open')).toBeTruthy();
    expect(within(entry(region, 'Add rate limiting to the')).getByText('Closed · too long')).toBeTruthy();
    const dawn = entry(region, 'Dawn audit');
    expect(within(dawn).getByText('Closed · skipped')).toBeTruthy();
    expect(within(dawn).getByText(`${w('patrol')}: Dawn audit`)).toBeTruthy();
    expect(dawn.querySelector('[data-rail-tile] .cb-icon-errandPatrol')).toBeTruthy();
  });

  it('links each entry to its Quest, and a script run to its run', () => {
    const { region, onOpenQuest, onOpenRun } = feed();
    fireEvent.click(
      within(entry(region, 'The Coronation of v0.8.1')).getByRole('button', { name: `Open ${w('quest')}` }),
    );
    expect(onOpenQuest).toHaveBeenCalledWith(CROWN);
    fireEvent.click(
      within(entry(region, 'The Siege of the Flaky Smoke Test')).getByRole('button', { name: `Open ${w('quest')}` }),
    );
    expect(onOpenQuest).toHaveBeenLastCalledWith(SIEGE);

    const run = entry(region, 'Backed up 4 repos to the vault: 412 MB.');
    expect(within(run).getByText('Backed up 4 repos to the vault: 412 MB.')).toBeTruthy();
    expect(within(run).getByText(`${w('patrol')}: Nightly backup`)).toBeTruthy();
    expect(within(run).getByText('Ran')).toBeTruthy();
    fireEvent.click(within(run).getByRole('button', { name: 'Run log' }));
    expect(onOpenRun).toHaveBeenCalledWith('backup', 'run-1');
    const failed = entry(region, 'Backup failed: the vault did not answer within 30 s.');
    expect(within(failed).getByText('Failed')).toBeTruthy();
    expect(failed.querySelector('[data-rail-tile]')!.getAttribute('title')).toContain('failed');
  });

  it('filters by project with a chip per project, in its colour', () => {
    const { region, onProject, view } = feed();
    const chips = within(region).getByRole('group', { name: 'Filter by project' });
    const all = within(chips).getByRole('button', { name: /^All/ });
    expect(all.getAttribute('aria-pressed')).toBe('true');
    expect(all.textContent).toBe('All6');
    const lantern = within(chips).getByRole('button', { name: /^lantern/ });
    expect(lantern.textContent).toBe('lantern2');
    expect(within(chips).getByRole('button', { name: /^quarry/ }).textContent).toBe('quarry2');
    expect(lantern.getAttribute('aria-pressed')).toBe('false');
    expect(lantern.className).toMatch(/bg-\w+-100/);
    fireEvent.click(lantern);
    expect(onProject).toHaveBeenCalledWith(LANTERN);

    view.rerender(
      <DeedsFeed
        state={LOADED}
        sessions={SESSIONS}
        patrols={PATROLS}
        project={LANTERN}
        now={NOW}
        onProject={onProject}
        onOpenQuest={vi.fn()}
        onOpenRun={vi.fn()}
        onLoadOlder={vi.fn()}
      />,
    );
    const pressed = within(region).getByRole('button', { name: /^lantern/ });
    expect(pressed.getAttribute('aria-pressed')).toBe('true');
    expect(pressed.className).toMatch(/bg-\w+-500/);
    // Only lantern's entries show, and the other chips stay.
    expect(within(region).queryByRole('listitem', { name: 'Dawn audit' })).toBeNull();
    expect(within(region).getByRole('button', { name: /^quarry/ })).toBeTruthy();
    fireEvent.click(within(region).getByRole('button', { name: /^All/ }));
    expect(onProject).toHaveBeenLastCalledWith(undefined);
  });

  it('shows details as plain text, never as links or HTML', () => {
    const { region } = feed();
    const crown = entry(region, 'The Coronation of v0.8.1');
    expect(crown.querySelector('img')).toBeNull();
    expect(crown.querySelector('[onerror]')).toBeNull();
    expect(within(crown).getByText('See https://example.com for the notes')).toBeTruthy();
    for (const line of crown.querySelectorAll('[data-deed]')) expect(line.querySelector('a')).toBeNull();
  });

  it('says so in one line when there are none, or why it couldn’t read them', () => {
    feed({ state: { deeds: [], loaded: true } });
    expect(
      screen.getByText(`No ${w('deedsFeed')} yet: when a ${w('quest')} finishes a turn, it shows here.`),
    ).toBeTruthy();
    cleanup();
    feed({ state: { deeds: [], loaded: false, error: 'the hub is unreachable' } });
    expect(screen.getByRole('alert').textContent).toBe(`Couldn’t read the ${w('deedsFeed')}: the hub is unreachable`);
    cleanup();
    feed({ state: { deeds: [], loaded: false } });
    expect(screen.getByText(`Reading the ${w('deedsFeed')}…`)).toBeTruthy();
  });

  it('loads older days', () => {
    const observed: Element[] = [];
    let fire: (entries: { isIntersecting: boolean }[]) => void = () => {};
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
          fire = callback;
        }
        observe(element: Element) {
          observed.push(element);
        }
        disconnect() {}
      },
    );
    const { region, onLoadOlder } = feed({ state: { ...LOADED, older: at(10, 9, 0) } });
    fireEvent.click(within(region).getByRole('button', { name: 'Load older days' }));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    expect(observed).toHaveLength(1);
    fire([{ isIntersecting: true }]);
    expect(onLoadOlder).toHaveBeenCalledTimes(2);
    cleanup();
    observed.length = 0;
    const none = feed();
    expect(within(none.region).queryByRole('button', { name: 'Load older days' })).toBeNull();
    expect(observed).toHaveLength(0);
  });

  it('on a phone, shows the same entries, chips and links with the totals line, and no unfolding', () => {
    const { region, onProject, onOpenQuest } = feed({ phone: true });
    expect(region.querySelector('details')).toBeNull();
    expect(region.querySelector('summary')).toBeNull();
    const crown = entry(region, 'The Coronation of v0.8.1');
    expect(crown.textContent).toContain('4 turns · 12 files · PR #319 · $1.84 · 42m');
    expect(crown.textContent).not.toContain('Closing summary: v0.8.1 is tagged');
    const siege = entry(region, 'The Siege of the Flaky Smoke Test');
    expect(siege.textContent).toContain('3 turns · 12 files · $1.84 · 42m');
    fireEvent.click(within(siege).getByRole('button', { name: `Open ${w('quest')}` }));
    expect(onOpenQuest).toHaveBeenCalledWith(SIEGE);
    fireEvent.click(within(region).getByRole('button', { name: /^quarry/ }));
    expect(onProject).toHaveBeenCalledWith(QUARRY);
  });

  it('marks nothing in blue', () => {
    const { region } = feed({ state: { ...LOADED, older: at(10, 9, 0) } });
    for (const element of [region, ...region.querySelectorAll('*')]) {
      expect(element.getAttribute('class') ?? '').not.toMatch(/blue-|sky-/);
    }
  });
});

describe("QuestDeeds, in a Quest's side panel", () => {
  afterEach(() => cleanup());
  const env = (seq: number, type: Envelope['type'], payload: unknown): Envelope =>
    ({ v: 1, seq, session: CROWN, ts: seq, type, payload }) as unknown as Envelope;
  const ID = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${n}`;

  it("shows this Quest's Deeds from its events, Close's marked apart", () => {
    const { container } = render(
      <QuestDeeds
        envelopes={[
          env(3, 'deed.recorded', { id: ID(1), deed: 'Fixed the tab badge', detail: 'It counted dismissed Errands.' }),
          env(9, 'deed.recorded', { id: ID(2), deed: 'Moved the hub to Node 24' }),
          env(12, 'deed.recorded', { id: ID(3), deed: 'Shipped the badge fix', closing: true }),
          env(13, 'deeds.closing', { outcome: 'recorded' }),
        ]}
      />,
    );
    const block = screen.getByRole('region', { name: w('deeds') });
    expect(block.className).toContain('amber');
    expect(block.className).not.toContain('blue');
    expect(within(block).getByRole('heading', { name: w('deeds') })).toBeTruthy();
    const lines = [...container.querySelectorAll('[data-deed]')];
    expect(lines.map((li) => li.querySelector('[data-deed-text]')?.textContent)).toEqual([
      'Fixed the tab badge',
      'Moved the hub to Node 24',
      'Shipped the badge fix',
    ]);
    expect(lines[0]!.textContent).toContain('It counted dismissed Errands.');
    expect(lines[2]!.querySelector('[title="From Close"]')).not.toBeNull();
    expect(lines[0]!.querySelector('[title="From Close"]')).toBeNull();
    expect(screen.queryByText('None yet.')).toBeNull();
  });

  it('says None yet with no Deeds, and why the call at Close wrote none', () => {
    const { rerender } = render(<QuestDeeds envelopes={[]} />);
    expect(screen.getByText('None yet.')).toBeTruthy();
    rerender(<QuestDeeds envelopes={[env(5, 'deeds.closing', { outcome: 'timeout' })]} />);
    expect(screen.getByText('No Deeds recorded: the call took too long.')).toBeTruthy();
  });
});
