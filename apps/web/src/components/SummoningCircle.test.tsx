import { cleanup, render, screen, within } from '@testing-library/react';
import type { Cast } from '@crystal-bridge/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { hasCircle, SummoningCircle } from './SummoningCircle.js';

const cast = (extra: Partial<Cast>): Cast => ({
  id: '11111111-1111-4111-8111-111111111111',
  session: '22222222-2222-4222-8222-222222222222',
  summon: 'render',
  name: 'encode',
  command: 'encode all',
  onFinish: 'notify',
  state: 'running',
  startedAt: 0,
  logTail: 'frame 12\n',
  ...extra,
});
const HERE = { name: 'here', local: true };

describe('SummoningCircle', () => {
  afterEach(() => cleanup());

  it('stays away on a Kingdom that has only itself and no Casts', () => {
    expect(hasCircle([HERE], [])).toBe(false);
    expect(hasCircle([HERE, { name: 'render' }], [])).toBe(true);
    expect(hasCircle([HERE], [cast({})])).toBe(true);
  });

  it('lists the Summons, how many Casts each is running, and leaves out the Kingdom itself until it has some', () => {
    render(<SummoningCircle summons={[HERE, { name: 'render' }]} casts={[cast({})]} now={60_000} kingdom="Forge" />);
    const list = within(screen.getByRole('list', { name: 'Summons' }));
    expect(list.getAllByRole('listitem').map((row) => row.textContent)).toEqual(['render1 running']);
    cleanup();
    render(<SummoningCircle summons={[HERE]} casts={[cast({ summon: 'here' })]} now={0} kingdom="Forge" />);
    expect(screen.getByText('Forge is casting encode!')).toBeTruthy();
  });

  it('puts running Casts first, then past ones, each with how it ended and how long it took', () => {
    const casts = [
      cast({ id: 'a', name: 'old', state: 'failed', exitCode: 3, finishedAt: 90_000 }),
      cast({ id: 'b', name: 'now', startedAt: 30_000 }),
    ];
    render(<SummoningCircle summons={[]} casts={casts} now={120_000} kingdom="Forge" />);
    const rows = within(screen.getByRole('list', { name: 'Casts' })).getAllByRole('listitem');
    expect(rows[0]!.textContent).toMatch(/render is casting now!.*1m/);
    expect(rows[1]!.textContent).toMatch(/old fizzled! \(3\).*render.*1m/);
  });

  it('keeps each log end folded under its Cast', () => {
    render(<SummoningCircle summons={[]} casts={[cast({})]} now={0} kingdom="Forge" />);
    expect(screen.getByText('frame 12').closest('details')).not.toBeNull();
  });

  it('draws a live count as a bar, with the item it’s on', () => {
    const progress = { done: 12, total: 50, label: 'episode-12.mkv' };
    render(<SummoningCircle summons={[]} casts={[cast({ progress })]} now={0} kingdom="Forge" />);
    const bar = screen.getByRole('progressbar', { name: 'encode' });
    expect(bar.getAttribute('aria-valuenow')).toBe('12');
    expect(bar.getAttribute('aria-valuemax')).toBe('50');
    expect(screen.getByText('episode-12.mkv')).toBeTruthy();
  });

  it('stops drawing the bar once the Cast has ended', () => {
    const progress = { done: 12, total: 50 };
    render(<SummoningCircle summons={[]} casts={[cast({ progress, state: 'cancelled' })]} now={0} kingdom="Forge" />);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('counts and lists a waiting Cast after the one that’s really running', () => {
    const casts = [cast({ id: 'a', name: 'next', queued: true, startedAt: 50 }), cast({ id: 'b', name: 'now' })];
    render(<SummoningCircle summons={[{ name: 'render' }]} casts={casts} now={100} kingdom="Forge" />);
    expect(screen.getByRole('list', { name: 'Summons' }).textContent).toBe('render1 running');
    const rows = within(screen.getByRole('list', { name: 'Casts' })).getAllByRole('listitem');
    expect(rows[0]!.textContent).toMatch(/casting now/);
    expect(rows[1]!.textContent).toMatch(/next awaits/);
  });

  it('says so when nothing has run yet', () => {
    render(<SummoningCircle summons={[{ name: 'render' }]} casts={[]} now={0} kingdom="Forge" />);
    expect(screen.getByText(/No Casts yet/)).toBeTruthy();
  });
});
