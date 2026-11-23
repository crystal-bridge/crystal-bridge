import type { ListedPatrol, PatrolRun } from '@crystal-bridge/protocol';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PatrolsState } from '../patrols.js';
import { Watchtower } from './Watchtower.js';

const NOW = Date.parse('2026-11-20T21:40:00Z');
const SESSION = '22222222-2222-4222-8222-222222222222';
let runs = 0;
const run = (extra: Partial<PatrolRun> = {}): PatrolRun => ({
  id: `33333333-3333-4333-8333-${String(++runs).padStart(12, '0')}`,
  startedAt: NOW - 3_600_000,
  finishedAt: NOW - 3_000_000,
  trigger: 'schedule',
  outcome: 'finished',
  ...extra,
});
const quest = (extra: Partial<ListedPatrol> = {}): ListedPatrol => ({
  id: 'sweep',
  manifest: {
    name: 'Dependency sweep',
    schedule: { cron: '0 9 * * 2', timezone: 'UTC' },
    quest: { project: '~/code/app', promptText: 'Sweep.' },
  } as ListedPatrol['manifest'],
  nextRunAt: NOW + 20 * 60_000,
  failures: 0,
  ...extra,
});
const script = (extra: Partial<ListedPatrol> = {}): ListedPatrol => ({
  id: 'backup',
  manifest: {
    name: 'Backup check',
    schedule: { cron: '30 3 * * *', timezone: 'Europe/Berlin' },
    script: { command: ['./check.sh'] },
  } as ListedPatrol['manifest'],
  nextRunAt: NOW + 5 * 3_600_000,
  failures: 1,
  ...extra,
});
const state = (patrols: ListedPatrol[], byId: Record<string, PatrolRun[]> = {}): PatrolsState => ({
  patrols,
  runs: byId,
  editable: true,
  loaded: true,
});

afterEach(cleanup);

describe('Watchtower', () => {
  it('shows a card per Patrol with its next run, how it stands and how its last run ended', () => {
    render(
      <Watchtower
        state={state([quest(), script()], {
          sweep: [run({ outcome: 'needs-you', session: SESSION })],
          backup: [run({ outcome: 'failed', reason: 'exit code 2' })],
        })}
        now={NOW}
      />,
    );
    const sweep = screen.getByRole('listitem', { name: 'Dependency sweep' });
    expect(within(sweep).getByText('20m')).toBeTruthy();
    expect(within(sweep).getAllByText('Waiting on you').length).toBeGreaterThan(0);
    const backup = screen.getByRole('listitem', { name: 'Backup check' });
    expect(within(backup).getByText('Turned back')).toBeTruthy();
    expect(within(backup).getByText('5h 0m')).toBeTruthy();
    // The schedule's own zone shows when it isn't the browser's.
    expect(within(backup).getByText(/Europe\/Berlin/)).toBeTruthy();
  });

  it('says what stops a Patrol: a stand-down, or a patrol.json that doesn’t load', () => {
    render(
      <Watchtower
        state={state([
          quest({ paused: 'Stood down after 3 failed runs in a row' }),
          { id: 'broken', error: 'quest.mode: not a mode' },
        ])}
        now={NOW}
      />,
    );
    const sweep = screen.getByRole('listitem', { name: 'Dependency sweep' });
    expect(within(sweep).getByText('Stood down')).toBeTruthy();
    expect(within(sweep).getByText(/after 3 failed runs/)).toBeTruthy();
    const broken = screen.getByRole('listitem', { name: 'broken' });
    expect(within(broken).getByText(/quest\.mode: not a mode/)).toBeTruthy();
  });

  it('runs, pauses, resumes and deletes through its handlers, deleting only once confirmed', async () => {
    const onRun = vi.fn();
    const onChange = vi.fn();
    render(
      <Watchtower
        state={state([quest(), script({ paused: 'by hand' })])}
        now={NOW}
        onRun={onRun}
        onChange={onChange}
      />,
    );
    const sweep = screen.getByRole('listitem', { name: 'Dependency sweep' });
    fireEvent.click(within(sweep).getByRole('button', { name: /Run now/ }));
    await act(async () => {});
    expect(onRun).toHaveBeenCalledWith('sweep');
    fireEvent.click(within(sweep).getByRole('button', { name: /Pause/ }));
    await act(async () => {});
    expect(onChange).toHaveBeenCalledWith('sweep', 'pause');
    const backup = screen.getByRole('listitem', { name: 'Backup check' });
    fireEvent.click(within(backup).getByRole('button', { name: /Resume/ }));
    await act(async () => {});
    expect(onChange).toHaveBeenCalledWith('backup', 'resume');

    fireEvent.click(within(sweep).getByRole('button', { name: 'Delete' }));
    await act(async () => {});
    expect(onChange).not.toHaveBeenCalledWith('sweep', 'delete');
    fireEvent.click(within(sweep).getByRole('button', { name: /Delete Dependency sweep for good/ }));
    await act(async () => {});
    expect(onChange).toHaveBeenCalledWith('sweep', 'delete');
  });

  it('shows a refusal from the hub on the card that asked', async () => {
    const onChange = vi.fn().mockRejectedValue(new Error('that Kingdom is offline'));
    render(<Watchtower state={state([quest()])} now={NOW} onRun={vi.fn()} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Pause/ }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'that Kingdom is offline');
  });

  it('opens a Patrol’s runs with their reasons, a Quest’s link and a script’s output', () => {
    const onOpenQuest = vi.fn();
    render(
      <Watchtower
        state={state([quest(), script()], {
          sweep: [run({ session: SESSION }), run({ outcome: 'skipped', reason: 'the last run was still out' })],
          backup: [run({ outcome: 'failed', exitCode: 2, stderr: 'repository is locked' })],
        })}
        now={NOW}
        onOpenQuest={onOpenQuest}
      />,
    );
    const sweep = screen.getByRole('listitem', { name: 'Dependency sweep' });
    fireEvent.click(within(sweep).getByRole('button', { name: /Runs/ }));
    const history = screen.getByRole('region', { name: 'Dependency sweep runs' });
    expect(within(history).getByText('the last run was still out')).toBeTruthy();
    fireEvent.click(within(history).getByRole('button', { name: 'Open Quest' }));
    expect(onOpenQuest).toHaveBeenCalledWith(SESSION);

    fireEvent.click(
      within(screen.getByRole('listitem', { name: 'Backup check' })).getByRole('button', { name: /Runs/ }),
    );
    const output = screen.getByRole('region', { name: 'Backup check runs' });
    fireEvent.click(within(output).getByText(/Output/));
    expect(within(output).getByText('repository is locked')).toBeTruthy();
  });

  it('is read-only without handlers, as on the phone', () => {
    render(<Watchtower state={state([quest()])} now={NOW} />);
    expect(screen.queryByRole('button', { name: /Run now|Pause|Delete/ })).toBeNull();
  });

  it('shows nothing while it loads or when the Kingdom has no Patrols', () => {
    const { container, rerender } = render(<Watchtower state={{ ...state([]), loaded: false }} now={NOW} />);
    expect(container.innerHTML).toBe('');
    rerender(<Watchtower state={state([])} now={NOW} />);
    expect(container.innerHTML).toBe('');
  });

  it('brings a Patrol’s runs into view when they open, since they open below every card', () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    render(<Watchtower state={state([quest(), script()])} now={NOW} />);
    fireEvent.click(
      within(screen.getByRole('listitem', { name: 'Backup check' })).getByRole('button', { name: /Runs/ }),
    );
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(scrolled.mock.contexts[0]).toBe(screen.getByRole('region', { name: 'Backup check runs' }));
  });

  it('opens a run asked for from the feed', () => {
    const asked = run({ outcome: 'failed' });
    render(
      <Watchtower
        state={state([script()], { backup: [run(), asked] })}
        now={NOW}
        focus={{ patrol: 'backup', run: asked.id }}
      />,
    );
    const list = screen.getByRole('region', { name: 'Backup check runs' });
    expect(list.querySelector(`#patrol-run-${asked.id}`)).not.toBeNull();
  });

  describe('the form', () => {
    const forms = {
      onSave: vi.fn(async () => {}),
      onPreview: vi.fn(async () => [NOW + 3_600_000]),
      projects: [],
    };

    it('says each schedule in plain words, with its zone when it isn’t the browser’s', () => {
      render(<Watchtower state={state([quest(), script()])} now={NOW} zone="UTC" />);
      expect(
        within(screen.getByRole('listitem', { name: 'Dependency sweep' })).getByText('Every Tue at 09:00'),
      ).toBeTruthy();
      expect(
        within(screen.getByRole('listitem', { name: 'Backup check' })).getByText('Daily at 03:30 (Europe/Berlin)'),
      ).toBeTruthy();
    });

    it('offers New Patrol on a Kingdom that takes Patrols from the app, even before it has one', () => {
      render(<Watchtower state={state([])} now={NOW} zone="UTC" {...forms} />);
      fireEvent.click(screen.getByRole('button', { name: /New Patrol/ }));
      expect(screen.getByRole('region', { name: 'New Patrol' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('region', { name: 'New Patrol' })).toBeNull();
    });

    it('opens New Patrol drafted from a Board item, and lets the draft go when it closes', () => {
      const seed = { name: 'Fix the retry loop', project: '/repo', promptText: 'Fix it.', board: 'quest-board' };
      const onSeedUsed = vi.fn();
      const { rerender } = render(
        <Watchtower state={state([])} now={NOW} zone="UTC" {...forms} seed={seed} onSeedUsed={onSeedUsed} />,
      );
      const form = screen.getByRole('region', { name: 'New Patrol' });
      expect((within(form).getByLabelText('Name') as HTMLInputElement).value).toBe('Fix the retry loop');
      // Taken at once, so leaving the Castle and coming back doesn't open it again.
      expect(onSeedUsed).toHaveBeenCalledTimes(1);
      rerender(<Watchtower state={state([])} now={NOW} zone="UTC" {...forms} onSeedUsed={onSeedUsed} />);
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Fix the retry loop');
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('region', { name: 'New Patrol' })).toBeNull();
      // Another item with the same title starts its own form.
      rerender(
        <Watchtower state={state([])} now={NOW} zone="UTC" {...forms} seed={{ ...seed }} onSeedUsed={onSeedUsed} />,
      );
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Fix the retry loop');
      expect(onSeedUsed).toHaveBeenCalledTimes(2);
    });

    it('edits a Quest Patrol, never a script one, and offers nothing where the Kingdom takes only files', () => {
      const { rerender } = render(<Watchtower state={state([quest(), script()])} now={NOW} zone="UTC" {...forms} />);
      expect(
        within(screen.getByRole('listitem', { name: 'Backup check' })).queryByRole('button', { name: /Edit/ }),
      ).toBeNull();
      fireEvent.click(
        within(screen.getByRole('listitem', { name: 'Dependency sweep' })).getByRole('button', { name: /Edit/ }),
      );
      expect(screen.getByRole('region', { name: 'Edit Dependency sweep' })).toBeTruthy();
      rerender(<Watchtower state={{ ...state([quest()]), editable: false }} now={NOW} zone="UTC" {...forms} />);
      expect(screen.queryByRole('button', { name: /New Patrol|Edit/ })).toBeNull();
      expect(screen.queryByRole('region', { name: 'Edit Dependency sweep' })).toBeNull();
    });
  });
});
