import type { Errand, ListedPatrol, Project } from '@crystal-bridge/protocol';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { w } from '../theme/words.js';
import { ErrandsPanel, QuestErrands } from './Errands.js';
import type { SessionSummary } from './SessionList.js';

const NOW = Date.parse('2026-11-20T21:40:00Z');
const MINUTE = 60_000;
const QUEST = '11111111-1111-4111-8111-111111111111';
const OLD_QUEST = '22222222-2222-4222-8222-222222222222';
const PATROL_QUEST = '33333333-3333-4333-8333-333333333333';

let ids = 0;
const errand = (extra: Partial<Errand> = {}): Errand => ({
  id: `44444444-4444-4444-8444-${String(++ids).padStart(12, '0')}`,
  title: 'An Errand',
  body: '',
  state: 'open',
  by: 'quest',
  created: NOW - 12 * MINUTE,
  updated: NOW - 12 * MINUTE,
  ...extra,
});

const smoke = errand({
  title: 'Run the smoke test against your dev hub',
  project: '/r/acme/lantern',
  session: QUEST,
  body: 'Start `pnpm dev`, then run:\n\n```sh\npnpm smoke --hub http://127.0.0.1:7700\n```\n\n<img src=x onerror=alert(1)>',
});
const update = errand({
  title: 'Install the edge update',
  project: '/r/acme/lantern',
  session: QUEST,
  created: NOW - 20 * MINUTE,
});
const restore = errand({
  title: 'Restore last night’s backup on staging',
  project: '/r/acme/quarry',
  session: OLD_QUEST,
  created: NOW - 60 * MINUTE,
});
const packages = errand({
  title: 'Update two outdated packages',
  project: '/r/tidepool/kelp',
  session: PATROL_QUEST,
  patrol: 'dawn-audit',
  created: NOW - 24 * 60 * MINUTE,
});
const certificate = errand({
  title: 'Renew the TLS certificate for the docs site',
  by: 'you',
  created: NOW - 4 * 24 * 60 * MINUTE,
});
const tagged = errand({
  title: 'Tag v1.4.0',
  project: '/r/acme/lantern',
  session: QUEST,
  state: 'done',
  closed: NOW - 60 * MINUTE,
});
const rotated = errand({
  title: 'Rotate the preview API key',
  project: '/r/acme/quarry',
  session: OLD_QUEST,
  state: 'dismissed',
  closed: NOW - 3 * 24 * 60 * MINUTE,
});
const ALL = [smoke, update, restore, packages, certificate, tagged, rotated];

const session = (id: string, label: string, status: SessionSummary['status']): SessionSummary => ({
  id,
  node: 'node-a',
  cwd: '/r/acme/lantern',
  label,
  status,
  createdAt: NOW - 2 * 60 * MINUTE,
});
const SESSIONS = [
  session(QUEST, 'The Siege of the Flaky Smoke Test', 'idle'),
  session(OLD_QUEST, 'The Ledger of Lost Migrations', 'closed'),
];
const PATROLS: ListedPatrol[] = [
  {
    id: 'dawn-audit',
    manifest: {
      name: 'Dawn audit',
      schedule: { cron: '0 6 * * *', timezone: 'UTC' },
      quest: { project: '/r/tidepool/kelp', promptText: 'Audit.' },
    } as ListedPatrol['manifest'],
    failures: 0,
  },
];

function panel(errands: Errand[] = ALL, extra: Partial<Parameters<typeof ErrandsPanel>[0]> = {}) {
  const onOpenQuest = vi.fn();
  const onState = vi.fn();
  render(
    <ErrandsPanel
      errands={errands}
      sessions={SESSIONS}
      patrols={PATROLS}
      now={NOW}
      onOpenQuest={onOpenQuest}
      onState={onState}
      {...extra}
    />,
  );
  return { onOpenQuest, onState, region: screen.getByRole('region', { name: w('errands') }) };
}

const LAYOUT_KEY = 'crystal-bridge.errands-layout';
beforeEach(() => localStorage.setItem(LAYOUT_KEY, 'checklist'));
afterEach(cleanup);

describe('ErrandsPanel, Checklist', () => {
  it('lists open Errands by project, each in its colour, with a share bar', () => {
    const { region } = panel();
    expect(within(region).getByRole('heading', { name: w('errands') })).toBeTruthy();
    const lantern = within(region).getByRole('group', { name: 'lantern' });
    expect(within(lantern).getByText('2')).toBeTruthy();
    expect(within(lantern).getAllByRole('listitem')).toHaveLength(2);
    expect(within(region).getByRole('group', { name: 'quarry' })).toBeTruthy();
    expect(within(region).getByRole('group', { name: 'kelp' })).toBeTruthy();
    expect(within(region).getByRole('group', { name: 'No project' })).toBeTruthy();
    // The project's name is in its colour.
    expect(within(lantern).getByText('lantern').className).toMatch(/text-\w+-700/);
    const bar = region.querySelector('[data-share-bar]')!;
    const segments = [...bar.children];
    expect(segments.map((s) => s.getAttribute('title'))).toEqual([
      'lantern: 2',
      'quarry: 1',
      'kelp: 1',
      'No project: 1',
    ]);
    expect((segments[0] as HTMLElement).style.flexGrow).toBe('2');
  });

  it('shows what left each one', () => {
    const { region, onOpenQuest } = panel();
    const smokeRow = within(region).getByRole('listitem', { name: smoke.title });
    const quest = within(smokeRow).getByRole('button', { name: 'The Siege of the Flaky Smoke Test' });
    expect(smokeRow.querySelector('.cb-icon-scrollUnfurled')).toBeTruthy();
    expect(within(smokeRow).getByText('12m')).toBeTruthy();
    fireEvent.click(quest);
    expect(onOpenQuest).toHaveBeenCalledWith(QUEST);

    const restoreRow = within(region).getByRole('listitem', { name: restore.title });
    fireEvent.click(within(restoreRow).getByRole('button', { name: 'The Ledger of Lost Migrations' }));
    expect(onOpenQuest).toHaveBeenLastCalledWith(OLD_QUEST);

    const patrolRow = within(region).getByRole('listitem', { name: packages.title });
    expect(within(patrolRow).getByText(`${w('patrol')}: Dawn audit`)).toBeTruthy();
    expect(patrolRow.querySelector('.cb-icon-errandPatrol')).toBeTruthy();

    const handRow = within(region).getByRole('listitem', { name: certificate.title });
    expect(within(handRow).getByText('Written by you')).toBeTruthy();
    expect(handRow.querySelector('.cb-icon-quillInk')).toBeTruthy();
  });

  it('renders the body’s Markdown, with a compact copy button per code block and no raw HTML', () => {
    const { region } = panel();
    const row = within(region).getByRole('listitem', { name: smoke.title });
    fireEvent.click(within(row).getByText(smoke.title));
    expect(within(row).getByText('pnpm smoke --hub http://127.0.0.1:7700')).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Copy code' })).toBeTruthy();
    // Compact: no language row above a one-line command.
    expect(row.querySelector('[data-code-header]')).toBeNull();
    expect(row.querySelector('img')).toBeNull();
    // The tag shows as the text it is, never as an element.
    expect(row.querySelector('[onerror]')).toBeNull();
    expect(within(row).getByText(/<img src=x onerror=alert\(1\)>/)).toBeTruthy();
  });

  it('folds a body under its title with no default marker, and a chevron only where there are details', () => {
    const { region } = panel();
    const row = within(region).getByRole('listitem', { name: smoke.title });
    const summary = row.querySelector('summary')!;
    expect(summary.className).toContain('list-none');
    expect(summary.className).toContain('[&::-webkit-details-marker]:hidden');
    // The title and the chevron share one line, so the tick lines up with the title.
    expect(summary.textContent).toBe(smoke.title);
    expect(summary.querySelector('.cb-icon-caret')).toBeTruthy();
    const bare = within(region).getByRole('listitem', { name: update.title });
    expect(bare.querySelector('summary')).toBeNull();
    expect(bare.querySelector('.cb-icon-caret')).toBeNull();
  });

  it('ticks one done, and dismisses one', () => {
    const { region, onState } = panel();
    fireEvent.click(within(region).getByRole('button', { name: `Mark done: ${update.title}` }));
    expect(onState).toHaveBeenCalledWith(update.id, 'done');
    fireEvent.click(within(region).getByRole('button', { name: `Dismiss: ${restore.title}` }));
    expect(onState).toHaveBeenLastCalledWith(restore.id, 'dismissed');
  });

  it('folds done and dismissed ones under a count, says they go after 30 days, and reopens one', () => {
    const { region, onState } = panel();
    const summary = within(region).getByText('Done and dismissed').closest('summary')!;
    expect(summary.textContent?.replace(/\s+/g, ' ').trim()).toBe('Done and dismissed 2');
    expect(summary.className).toContain('list-none');
    expect(summary.querySelector('.cb-icon-caret')).toBeTruthy();
    const fold = summary.closest('details')!;
    expect(fold.open).toBe(false);
    fireEvent.click(summary);
    expect(fold.open).toBe(true);
    expect(within(fold).getByText(tagged.title)).toBeTruthy();
    expect(within(fold).getByText(rotated.title)).toBeTruthy();
    expect(within(fold).getByText("Deleted 30 days after they're closed.")).toBeTruthy();
    fireEvent.click(within(fold).getByRole('button', { name: `Reopen: ${rotated.title}` }));
    expect(onState).toHaveBeenCalledWith(rotated.id, 'open');
  });

  it('says so in one line when none are open', () => {
    const { region } = panel([tagged, rotated]);
    expect(within(region).getByText(`No open ${w('errands')}.`)).toBeTruthy();
    expect(region.querySelector('[data-share-bar]')).toBeNull();
    expect(within(region).getByText('Done and dismissed')).toBeTruthy();
  });

  it('offers Checklist and Cards, and remembers the choice on this device', () => {
    const { region } = panel();
    const layout = within(region).getByRole('radiogroup', { name: 'Layout' });
    const checklist = within(layout).getByRole('radio', { name: 'Checklist' }) as HTMLInputElement;
    expect(checklist.checked).toBe(true);
    // Compact beside the heading: small sans text, not the Board's display face.
    for (const radio of within(layout).getAllByRole('radio')) {
      const label = radio.closest('label')!;
      expect(label.className).not.toContain('cb-display');
      expect(label.className).toContain('text-xs');
      expect(label.title).toBeTruthy();
      expect(label.querySelector('svg')!.getAttribute('width')).toBe('14');
    }
    fireEvent.click(within(layout).getByRole('radio', { name: 'Cards' }));
    expect(within(region).queryByRole('group', { name: 'lantern' })).toBeNull();
    cleanup();
    const again = panel().region;
    const cards = within(again).getByRole('radio', { name: 'Cards' }) as HTMLInputElement;
    expect(cards.checked).toBe(true);
    expect(localStorage.getItem(LAYOUT_KEY)).toBe('cards');
  });

  it('marks nothing in blue', () => {
    const { region } = panel();
    for (const element of [region, ...region.querySelectorAll('*')]) {
      expect(element.getAttribute('class') ?? '').not.toContain('blue-');
    }
  });
});

describe('ErrandsPanel, Cards', () => {
  // Local noon, so the days don't move with the time zone the tests run in.
  const NOON = new Date(2026, 10, 20, 12, 0).getTime();
  const HOUR = 60 * MINUTE;
  const fresh = { ...smoke, created: NOON - HOUR, updated: NOON - HOUR };
  const older = { ...packages, created: NOON - 24 * HOUR, updated: NOON - 24 * HOUR };
  const oldest = { ...certificate, created: NOON - 4 * 24 * HOUR, updated: NOON - 4 * 24 * HOUR };
  const CARDS = [oldest, fresh, older, tagged, rotated];
  beforeEach(() => localStorage.setItem(LAYOUT_KEY, 'cards'));

  it('groups by day, each card topped in its project colour, with an icon for what left it', () => {
    const { region, onState } = panel(CARDS, { now: NOON });
    const days = within(region)
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent);
    expect(days).toEqual(['Today', 'Yesterday', 'Earlier']);

    const card = within(region).getByRole('listitem', { name: fresh.title });
    // The body shows without opening anything, with its copy button.
    expect(within(card).getByText('pnpm smoke --hub http://127.0.0.1:7700')).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Copy code' })).toBeTruthy();
    expect(card.querySelector('[data-card-top]')!.className).toMatch(/\bbg-\w+-400\b/);
    expect(within(card).getByText('lantern')).toBeTruthy();
    expect(within(card).getByText('1h ago')).toBeTruthy();
    expect(within(card).getByTitle('Quest').querySelector('.cb-icon-scrollUnfurled')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Done' }));
    expect(onState).toHaveBeenCalledWith(fresh.id, 'done');
    fireEvent.click(within(card).getByRole('button', { name: `Dismiss: ${fresh.title}` }));
    expect(onState).toHaveBeenLastCalledWith(fresh.id, 'dismissed');

    const patrol = within(region).getByRole('listitem', { name: older.title });
    expect(within(patrol).getByTitle('Patrol').querySelector('.cb-icon-errandPatrol')).toBeTruthy();
    expect(within(patrol).getByText('kelp')).toBeTruthy();
    const hand = within(region).getByRole('listitem', { name: oldest.title });
    expect(within(hand).getByTitle('By hand').querySelector('.cb-icon-quillInk')).toBeTruthy();
    expect(within(hand).getByText('No project')).toBeTruthy();
  });

  it('shows the open count in its header, and the closed fold below', () => {
    const { region } = panel(CARDS, { now: NOON });
    expect(within(region).getByText('3 open')).toBeTruthy();
    expect(within(region).getByText('Done and dismissed')).toBeTruthy();
  });

  it('marks nothing in blue', () => {
    const { region } = panel(CARDS, { now: NOON });
    for (const element of [region, ...region.querySelectorAll('*')]) {
      expect(element.getAttribute('class') ?? '').not.toContain('blue-');
    }
  });
});

describe('ErrandsPanel, Add and Edit', () => {
  const PROJECTS: Project[] = [
    { path: '/r/acme/lantern', name: 'lantern' },
    { path: '/r/acme/quarry', name: 'quarry' },
  ];
  const fill = (form: HTMLElement, title: string, body = '') => {
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: title } });
    if (body) fireEvent.change(within(form).getByLabelText('Details'), { target: { value: body } });
  };

  it("adds one by hand, with an optional project from the Kingdom's projects", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    const { region } = panel(ALL, { projects: PROJECTS, onAdd });
    fireEvent.click(within(region).getByRole('button', { name: 'Add an Errand' }));
    const form = within(region).getByRole('form', { name: 'A new Errand, written by you' });
    const select = within(form).getByLabelText('Project') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['No project', 'lantern', 'quarry']);
    fill(form, '  Order the new keyboard  ', 'Details here');
    fireEvent.change(select, { target: { value: '/r/acme/quarry' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(onAdd).toHaveBeenCalledWith({
        title: 'Order the new keyboard',
        body: 'Details here',
        project: '/r/acme/quarry',
      }),
    );
    await waitFor(() => expect(within(region).queryByRole('form')).toBeNull());

    fireEvent.click(within(region).getByRole('button', { name: 'Add an Errand' }));
    fill(within(region).getByRole('form'), 'No project one');
    fireEvent.click(within(region).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onAdd).toHaveBeenLastCalledWith({ title: 'No project one', body: '' }));
    expect(onAdd.mock.calls[1]![0]).not.toHaveProperty('project');
  });

  it("keeps the tool's limits", async () => {
    const onAdd = vi.fn().mockRejectedValue(new Error('The hub is full of Errands'));
    const { region } = panel(ALL, { projects: PROJECTS, onAdd });
    fireEvent.click(within(region).getByRole('button', { name: 'Add an Errand' }));
    const form = within(region).getByRole('form');
    const title = within(form).getByLabelText('Title') as HTMLInputElement;
    expect(title.maxLength).toBe(120);
    expect(title.required).toBe(true);
    fill(form, 'Too wordy', 'x'.repeat(8001));
    fireEvent.click(within(form).getByRole('button', { name: 'Add' }));
    expect(within(form).getByText('At most 8000 characters')).toBeTruthy();
    expect(onAdd).not.toHaveBeenCalled();
    fill(form, 'Too wordy', 'x'.repeat(8000));
    fireEvent.click(within(form).getByRole('button', { name: 'Add' }));
    expect(await within(region).findByText('The hub is full of Errands')).toBeTruthy();
    expect(within(region).getByRole('form')).toBeTruthy();
  });

  it('edits one', async () => {
    const onEdit = vi.fn().mockResolvedValue(undefined);
    const { region } = panel(ALL, { onEdit });
    fireEvent.click(within(region).getByRole('button', { name: `Edit: ${smoke.title}` }));
    const form = within(region).getByRole('form');
    expect((within(form).getByLabelText('Title') as HTMLInputElement).value).toBe(smoke.title);
    expect((within(form).getByLabelText('Details') as HTMLTextAreaElement).value).toBe(smoke.body);
    expect(within(form).queryByLabelText('Project')).toBeNull();
    fill(form, 'Run the smoke test twice');
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onEdit).toHaveBeenCalledWith(smoke.id, { title: 'Run the smoke test twice', body: smoke.body }),
    );
    await waitFor(() => expect(within(region).queryByRole('form')).toBeNull());
  });

  it('offers Add and Edit in Cards too, in place of the card', () => {
    localStorage.setItem(LAYOUT_KEY, 'cards');
    const { region } = panel(ALL, { onAdd: vi.fn(), onEdit: vi.fn() });
    expect(within(region).getByRole('button', { name: 'Add an Errand' })).toBeTruthy();
    fireEvent.click(within(region).getByRole('button', { name: `Edit: ${update.title}` }));
    expect(within(region).queryByRole('listitem', { name: update.title })).toBeNull();
    expect(within(region).getByRole('form')).toBeTruthy();
  });

  it('offers no add or edit without the handlers', () => {
    const { region } = panel();
    expect(within(region).queryByRole('button', { name: 'Add an Errand' })).toBeNull();
    expect(within(region).queryByRole('button', { name: /^Edit:/ })).toBeNull();
  });

  it('offers no add, edit or dismiss when read-only, but still ticks and reopens', () => {
    for (const layout of ['checklist', 'cards']) {
      localStorage.setItem(LAYOUT_KEY, layout);
      const { region, onState } = panel(ALL, { readOnly: true, onAdd: vi.fn(), onEdit: vi.fn() });
      expect(within(region).queryByRole('button', { name: 'Add an Errand' })).toBeNull();
      expect(within(region).queryByRole('button', { name: /^Edit:/ })).toBeNull();
      expect(within(region).queryByRole('button', { name: /^Dismiss:/ })).toBeNull();
      fireEvent.click(
        layout === 'cards'
          ? within(within(region).getByRole('listitem', { name: update.title })).getByRole('button', { name: 'Done' })
          : within(region).getByRole('button', { name: `Mark done: ${update.title}` }),
      );
      expect(onState).toHaveBeenCalledWith(update.id, 'done');
      fireEvent.click(within(region).getByText('Done and dismissed'));
      fireEvent.click(within(region).getByRole('button', { name: `Reopen: ${rotated.title}` }));
      expect(onState).toHaveBeenLastCalledWith(rotated.id, 'open');
      cleanup();
    }
  });
});

describe('ErrandsPanel, on a phone', () => {
  it('names each row’s project and age beside what left it, since the stripe alone doesn’t', () => {
    const { region, onOpenQuest } = panel(ALL, { phone: true });
    const row = within(region).getByRole('listitem', { name: smoke.title });
    const source = row.querySelector<HTMLElement>('[data-source]')!;
    expect([...source.children].map((part) => part.textContent)).toEqual(['', 'lantern', '·', '12m']);
    expect(source.querySelector('.cb-icon-scrollUnfurled')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: `Open ${w('quest')}: The Siege of the Flaky Smoke Test` }));
    expect(onOpenQuest).toHaveBeenCalledWith(QUEST);
    const hand = within(region).getByRole('listitem', { name: certificate.title });
    expect(hand.querySelector('[data-source]')!.textContent).toBe('No project·4d');
    expect(hand.querySelector('.cb-icon-quillInk')).toBeTruthy();
  });

  it('folds a body under its title with no default marker, and a chevron', () => {
    const { region } = panel(ALL, { phone: true });
    const row = within(region).getByRole('listitem', { name: smoke.title });
    const summary = row.querySelector('summary')!;
    expect(summary.className).toContain('list-none');
    expect(summary.textContent).toBe(smoke.title);
    expect(summary.querySelector('.cb-icon-caret')).toBeTruthy();
    expect(within(region).getByRole('listitem', { name: update.title }).querySelector('.cb-icon-caret')).toBeNull();
  });
});

describe("QuestErrands, in a Quest's side panel", () => {
  function block(errands: Errand[], quest = QUEST, extra: Partial<Parameters<typeof QuestErrands>[0]> = {}) {
    const onState = vi.fn();
    const { container } = render(<QuestErrands session={quest} errands={errands} onState={onState} {...extra} />);
    return { onState, container };
  }

  it("shows only this Quest's Errands, open first, with the fold", () => {
    const { onState } = block(ALL);
    const region = screen.getByRole('region', { name: w('errands') });
    expect(region.className).toContain('teal-');
    expect(region.querySelector('.cb-icon-errands')).toBeTruthy();
    expect(within(region).getByRole('heading', { name: w('errands') })).toBeTruthy();
    expect(within(region).getByTitle('2 open').textContent).toBe('2');
    expect(within(region).getByText('Steps this Quest left for you')).toBeTruthy();
    const rows = within(region)
      .getAllByRole('listitem')
      .map((row) => row.getAttribute('aria-label'))
      .filter(Boolean);
    expect(rows).toEqual([smoke.title, update.title]);
    expect(within(region).queryByText(restore.title)).toBeNull();
    expect(within(region).queryByText(certificate.title)).toBeNull();
    // No Add: a hand-written Errand has no Quest, so one added here couldn't belong to it.
    expect(within(region).queryByRole('button', { name: /^Add/ })).toBeNull();
    fireEvent.click(within(region).getByRole('button', { name: `Mark done: ${update.title}` }));
    expect(onState).toHaveBeenCalledWith(update.id, 'done');
    fireEvent.click(within(region).getByRole('button', { name: `Dismiss: ${smoke.title}` }));
    expect(onState).toHaveBeenLastCalledWith(smoke.id, 'dismissed');
    const summary = within(region).getByText('Done and dismissed').closest('summary')!;
    expect(summary.textContent?.replace(/\s+/g, ' ').trim()).toBe('Done and dismissed 1');
    fireEvent.click(summary);
    fireEvent.click(within(region).getByRole('button', { name: `Reopen: ${tagged.title}` }));
    expect(onState).toHaveBeenLastCalledWith(tagged.id, 'open');
    expect(within(region).queryByText(rotated.title)).toBeNull();
    for (const element of [region, ...region.querySelectorAll('*')]) {
      expect(element.getAttribute('class') ?? '').not.toContain('blue-');
    }
  });

  it('shows each body open, with no fold', () => {
    block(ALL);
    const region = screen.getByRole('region', { name: w('errands') });
    const row = within(region).getByRole('listitem', { name: smoke.title });
    expect(row.querySelector('details')).toBeNull();
    expect(within(row).getByText('pnpm smoke --hub http://127.0.0.1:7700')).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Copy code' })).toBeTruthy();
  });

  it('says All done. when none are open but some are closed', () => {
    block([restore, tagged]);
    const region = screen.getByRole('region', { name: w('errands') });
    expect(within(region).getByText('All done.')).toBeTruthy();
    expect(within(region).queryByTitle(/open$/)).toBeNull();
    expect(within(region).getByText('Done and dismissed')).toBeTruthy();
  });

  it('leaves out Dismiss when read-only, but still ticks', () => {
    const { onState } = block(ALL, QUEST, { readOnly: true });
    expect(screen.queryByRole('button', { name: /^Dismiss:/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: `Mark done: ${smoke.title}` }));
    expect(onState).toHaveBeenCalledWith(smoke.id, 'done');
  });

  it('a fork lists none of the Quest it came from', () => {
    const FORK = '55555555-5555-4555-8555-555555555555';
    const own = errand({ title: 'Check the fork’s branch', session: FORK });
    block([...ALL, own], FORK);
    const region = screen.getByRole('region', { name: w('errands') });
    expect(within(region).getByText(own.title)).toBeTruthy();
    expect(within(region).queryByText(smoke.title)).toBeNull();
    expect(within(region).queryByText(update.title)).toBeNull();
    expect(within(region).queryByText('Done and dismissed')).toBeNull();
  });

  it('has the id the chat line scrolls to', () => {
    block(ALL);
    expect(screen.getByRole('region', { name: w('errands') }).id).toBe(`errands-${QUEST}`);
  });

  it('renders nothing when the Quest left none', () => {
    const { container } = block(ALL, '55555555-5555-4555-8555-555555555555');
    expect(container.innerHTML).toBe('');
  });
});
