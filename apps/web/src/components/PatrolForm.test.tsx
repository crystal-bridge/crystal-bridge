import type { ListedPatrol, PatrolManifest, Schedule } from '@crystal-bridge/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PatrolForm, type PatrolFormProps } from './PatrolForm.js';

const NOW = Date.parse('2026-11-20T21:40:00Z');
const MONDAY_9 = Date.parse('2026-11-23T09:00:00Z');

afterEach(cleanup);

function setup(extra: Partial<PatrolFormProps> = {}) {
  const onPreview = vi.fn<PatrolFormProps['onPreview']>(async () => [MONDAY_9]);
  const onSave = vi.fn<PatrolFormProps['onSave']>(async () => {});
  const onClose = vi.fn();
  render(
    <PatrolForm
      taken={['sweep']}
      projects={[{ name: 'app', path: '~/code/app' }]}
      now={NOW}
      zone="UTC"
      previewDelayMs={0}
      onPreview={onPreview}
      onSave={onSave}
      onClose={onClose}
      {...extra}
    />,
  );
  return { onPreview, onSave, onClose };
}

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('PatrolForm', () => {
  it('creates a Quest Patrol named after its name, after showing its next runs', async () => {
    const { onPreview, onSave, onClose } = setup();
    await flush();
    expect(onPreview).toHaveBeenLastCalledWith(
      { rule: 'FREQ=DAILY', start: '2026-11-20T09:00', timezone: 'UTC' },
      expect.any(AbortSignal),
    );
    expect(screen.getByRole('list', { name: 'Next runs' }).textContent).toMatch(/Mon/);

    type('Name', 'Nightly triage');
    type('Project', '~/code/app');
    type('Prompt', 'Triage new issues. Never push.');
    expect(screen.getByText(/nightly-triage/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Save/ }));
    await flush();
    expect(onSave).toHaveBeenCalledWith('nightly-triage', {
      name: 'Nightly triage',
      schedule: { rule: 'FREQ=DAILY', start: '2026-11-20T09:00', timezone: 'UTC' },
      quest: { project: '~/code/app', promptText: 'Triage new issues. Never push.', mode: 'auto' },
    } satisfies PatrolManifest);
    expect(onClose).toHaveBeenCalled();
  });

  it('starts from a Board item’s draft, posting its runs back to that Board', async () => {
    const { onSave } = setup({
      seed: {
        name: 'Fix the retry loop',
        project: '/home/me/code/repo',
        promptText: 'Fix it.\n\n<untrusted-item>{}</untrusted-item>',
        mode: 'plan',
        worktree: true,
        board: 'quest-board',
      },
    });
    await flush();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Fix the retry loop');
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toContain('<untrusted-item>');
    expect(screen.getByText(/Reports each run to the quest-board Board/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Save/ }));
    await flush();
    expect(onSave).toHaveBeenCalledWith('fix-the-retry-loop', {
      name: 'Fix the retry loop',
      schedule: { rule: 'FREQ=DAILY', start: '2026-11-20T09:00', timezone: 'UTC' },
      quest: {
        project: '/home/me/code/repo',
        promptText: 'Fix it.\n\n<untrusted-item>{}</untrusted-item>',
        mode: 'plan',
        worktree: true,
      },
      board: 'quest-board',
    } satisfies PatrolManifest);
  });

  it('fills the schedule from a preset and builds weekly days', async () => {
    const { onPreview } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Weekdays at 09:00' }));
    await flush();
    expect((onPreview.mock.lastCall![0] as Schedule & { rule: string }).rule).toBe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Fri' }));
    await flush();
    expect((onPreview.mock.lastCall![0] as Schedule & { rule: string }).rule).toBe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH');
    expect(screen.getAllByText('Every Mon, Tue, Wed, Thu at 09:00').length).toBeGreaterThan(0);
  });

  it('takes cron, and shows the Kingdom’s reason when it refuses a schedule', async () => {
    const { onPreview } = setup({
      onPreview: vi.fn(async (schedule: Schedule) => {
        if ('cron' in schedule && schedule.cron.startsWith('99')) throw new Error('schedule: cron: 99 is no minute');
        return [MONDAY_9];
      }),
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Cron' }));
    type('Cron schedule', '99 9 * * *');
    await flush();
    expect(screen.getByRole('alert').textContent).toContain('99 is no minute');
    void onPreview;
  });

  it('says what’s missing before it saves', async () => {
    const { onSave } = setup();
    type('Name', 'Nightly triage');
    fireEvent.click(screen.getByRole('button', { name: /^Save/ }));
    await flush();
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/project/i);
  });

  it('edits a Patrol in place, keeping a prompt file until a new prompt is written', async () => {
    const patrol: ListedPatrol = {
      id: 'sweep',
      manifest: {
        name: 'Sweep',
        schedule: { cron: '0 9 * * 2', timezone: 'Europe/Berlin' },
        quest: { project: '~/code/app', prompt: 'sweep.md', mode: 'acceptEdits' },
      },
    };
    const { onSave } = setup({ patrol });
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Sweep');
    expect(screen.getByText(/sweep\.md/)).toBeTruthy();
    expect(screen.queryByLabelText('Prompt')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Save/ }));
    await flush();
    expect(onSave).toHaveBeenLastCalledWith('sweep', patrol.manifest);

    fireEvent.click(screen.getByRole('button', { name: /Write a new prompt/ }));
    type('Prompt', 'Sweep again.');
    fireEvent.click(screen.getByRole('button', { name: /^Save/ }));
    await flush();
    expect(onSave.mock.lastCall![1].quest).toEqual({
      project: '~/code/app',
      promptText: 'Sweep again.',
      mode: 'acceptEdits',
    });
  });

  it('keeps the form open with the Kingdom’s reason when a save is refused', async () => {
    const { onClose } = setup({
      onSave: vi.fn(async () => {
        throw new Error('there’s no such folder');
      }),
    });
    type('Name', 'Nightly triage');
    type('Project', '~/code/gone');
    type('Prompt', 'Triage.');
    fireEvent.click(screen.getByRole('button', { name: /^Save/ }));
    await flush();
    expect(screen.getByRole('alert').textContent).toContain('no such folder');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('says its preview heading in the theme’s words, without adding letters to them', async () => {
    setup();
    await flush();
    expect(document.body.textContent).not.toMatch(/watchs/i);
  });

  it('lets a number be cleared and retyped, and a preset start the schedule afresh', async () => {
    const { onPreview } = setup();
    const rule = () => (onPreview.mock.lastCall![0] as Schedule & { rule: string }).rule;
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: 'after' } });
    type('Every', '');
    type('Every', '5');
    await flush();
    expect(rule()).toBe('FREQ=DAILY;INTERVAL=5;COUNT=10');
    fireEvent.click(screen.getByRole('button', { name: 'Weekdays at 09:00' }));
    await flush();
    expect(rule()).toBe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
  });

  it('shows an engine the file names even where the Kingdom offers no choice, and can clear it', async () => {
    const patrol: ListedPatrol = {
      id: 'sweep',
      manifest: {
        name: 'Sweep',
        schedule: { cron: '0 9 * * 2', timezone: 'UTC' },
        quest: { project: '~/code/app', promptText: 'Sweep.', engine: 'interactive' },
      },
    };
    const { onSave } = setup({ patrol });
    const engine = screen.getByLabelText('Engine') as HTMLSelectElement;
    expect(engine.value).toBe('interactive');
    fireEvent.change(engine, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save/ }));
    await flush();
    expect(onSave.mock.lastCall![1].quest).toEqual({ project: '~/code/app', promptText: 'Sweep.' });
  });
});
