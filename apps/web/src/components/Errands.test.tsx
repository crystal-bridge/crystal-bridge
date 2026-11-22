import type { Errand, ListedPatrol } from '@crystal-bridge/protocol';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { w } from '../theme/words.js';
import { ErrandsPanel } from './Errands.js';
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
      layout="checklist"
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

  it('renders the body as the chat does, with a copy button per code block and no raw HTML', () => {
    const { region } = panel();
    const row = within(region).getByRole('listitem', { name: smoke.title });
    fireEvent.click(within(row).getByText(smoke.title));
    expect(within(row).getByText('pnpm smoke --hub http://127.0.0.1:7700')).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Copy code' })).toBeTruthy();
    expect(row.querySelector('img')).toBeNull();
    // The tag shows as the text it is, never as an element.
    expect(row.querySelector('[onerror]')).toBeNull();
    expect(within(row).getByText(/<img src=x onerror=alert\(1\)>/)).toBeTruthy();
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

  it('marks nothing in blue', () => {
    const { region } = panel();
    for (const element of [region, ...region.querySelectorAll('*')]) {
      expect(element.getAttribute('class') ?? '').not.toContain('blue-');
    }
  });
});
