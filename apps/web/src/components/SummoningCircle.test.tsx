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
    render(<SummoningCircle summons={[HERE, { name: 'render' }]} casts={[cast({})]} now={60_000} />);
    const list = within(screen.getByRole('list', { name: 'Summons' }));
    expect(list.getAllByRole('listitem').map((row) => row.textContent)).toEqual(['render1 running']);
  });

  it('puts running Casts first, then past ones, each with how it ended and how long it took', () => {
    const casts = [
      cast({ id: 'a', name: 'old', state: 'failed', exitCode: 3, finishedAt: 90_000 }),
      cast({ id: 'b', name: 'now', startedAt: 30_000 }),
    ];
    render(<SummoningCircle summons={[]} casts={casts} now={120_000} />);
    const rows = within(screen.getByRole('list', { name: 'Casts' })).getAllByRole('listitem');
    expect(rows[0]!.textContent).toMatch(/now.*render.*running.*1m/);
    expect(rows[1]!.textContent).toMatch(/old.*render.*failed.*exit 3.*1m/);
  });

  it('keeps each log end folded under its Cast', () => {
    render(<SummoningCircle summons={[]} casts={[cast({})]} now={0} />);
    expect(screen.getByText('frame 12').closest('details')).not.toBeNull();
  });

  it('says so when nothing has run yet', () => {
    render(<SummoningCircle summons={[{ name: 'render' }]} casts={[]} now={0} />);
    expect(screen.getByText(/No Casts yet/)).toBeTruthy();
  });
});
