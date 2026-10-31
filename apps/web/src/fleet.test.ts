import { describe, expect, it } from 'vitest';
import { fleetLine, type FleetRow } from './fleet.js';

const row = (overrides: Partial<FleetRow> = {}): FleetRow => ({
  id: 'a',
  name: 'Alpha',
  connected: true,
  ...overrides,
});

describe('fleetLine', () => {
  it('is quiet about a Kingdom on the hub’s release', () => {
    expect(fleetLine(row({ release: '1.0.0' }), '1.0.0')).toEqual({ text: '1.0.0', attention: false });
  });

  it('says when a Kingdom is behind', () => {
    expect(fleetLine(row({ release: '0.9.0' }), '1.0.0')).toEqual({ text: '0.9.0, behind 1.0.0', attention: true });
  });

  it('says a Kingdom has a release ready and is waiting to go idle, which it shows nowhere else', () => {
    const line = fleetLine(row({ release: '0.9.0', selfUpdate: { version: '1.0.0', state: 'waiting' } }), '1.0.0');
    expect(line).toEqual({ text: '0.9.0, 1.0.0 is ready and waits for its Quests', attention: false });
  });

  it('says when an update is running', () => {
    const line = fleetLine(row({ release: '0.9.0', selfUpdate: { version: '1.0.0', state: 'installing' } }), '1.0.0');
    expect(line).toEqual({ text: '0.9.0, installing 1.0.0', attention: false });
  });

  it('flags an update that failed, with its reason', () => {
    const update = { version: '1.0.0', state: 'failed' as const, reason: 'no npm' };
    expect(fleetLine(row({ release: '0.9.0', selfUpdate: update }), '1.0.0')).toEqual({
      text: '0.9.0, could not move to 1.0.0: no npm',
      attention: true,
    });
  });

  it('says a Kingdom is offline, which needs no attention of its own', () => {
    expect(fleetLine(row({ connected: false }), '1.0.0')).toEqual({ text: 'offline', attention: false });
  });

  it('shows a commit short, and never calls one behind', () => {
    expect(fleetLine(row({ release: '0123456789abcdef' }), '1.0.0')).toEqual({ text: '0123456', attention: false });
  });

  it('copes with a Kingdom that reports no release', () => {
    expect(fleetLine(row(), '1.0.0')).toEqual({ text: 'unknown release', attention: false });
  });
});
