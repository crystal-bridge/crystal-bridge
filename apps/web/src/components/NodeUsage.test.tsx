import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { formatUntil, NodeUsage, type NodeUsageRow } from './NodeUsage.js';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function row(overrides: Partial<NodeUsageRow> = {}): NodeUsageRow {
  return {
    node: 'local',
    ts: NOW - MIN,
    windows: [
      { id: 'five_hour', label: '5h', usedPct: 9, resetsAt: NOW + 37 * MIN, status: 'allowed' },
      {
        id: 'seven_day',
        label: '7d',
        usedPct: 84.6,
        resetsAt: NOW + (4 * 24 * 60 + 16 * 60) * MIN,
        status: 'allowed_warning',
      },
    ],
    ...overrides,
  };
}

describe('formatUntil', () => {
  it('formats minutes, hours and days, and a passed time as now', () => {
    expect(formatUntil(NOW + 37 * MIN, NOW)).toBe('37m');
    expect(formatUntil(NOW + 192 * MIN, NOW)).toBe('3h12m');
    expect(formatUntil(NOW + (2 * 24 * 60 + 4 * 60 + 5) * MIN, NOW)).toBe('2d4h');
    expect(formatUntil(NOW - MIN, NOW)).toBe('now');
  });
});

describe('NodeUsage', () => {
  afterEach(() => cleanup());

  it('shows each window of each node with percent used and time to reset', () => {
    render(<NodeUsage rows={[row()]} now={NOW} />);
    expect(screen.getByText('local')).toBeTruthy();
    expect(screen.getByText('5h 9%')).toBeTruthy();
    expect(screen.getByText('resets 37m')).toBeTruthy();
    expect(screen.getByText('7d 85%')).toBeTruthy();
    expect(screen.getByText('resets 4d16h')).toBeTruthy();
  });

  it('can leave out the node name where the Kingdom is already named', () => {
    render(<NodeUsage rows={[row()]} now={NOW} named={false} />);
    expect(screen.queryByText('local')).toBeNull();
    expect(screen.getByText('5h 9%')).toBeTruthy();
  });

  it('marks a window at 80% or more, or one the engine flags as limited, as high', () => {
    render(<NodeUsage rows={[row()]} now={NOW} />);
    expect(screen.getByText('7d 85%').getAttribute('data-level')).toBe('high');
    expect(screen.getByText('5h 9%').getAttribute('data-level')).toBe('low');
  });

  it('shows a window whose reset has passed as reset, since its old percentage no longer applies', () => {
    const rows = [
      row({ windows: [{ id: 'five_hour', label: '5h', usedPct: 90, resetsAt: NOW - MIN, status: 'allowed' }] }),
    ];
    render(<NodeUsage rows={rows} now={NOW} />);
    expect(screen.getByText('5h reset')).toBeTruthy();
    expect(screen.queryByText('5h 90%')).toBeNull();
  });

  it('says how old the numbers are once they are more than five minutes old', () => {
    render(<NodeUsage rows={[row({ ts: NOW - 42 * MIN })]} now={NOW} />);
    expect(screen.getByText('as of 42m ago')).toBeTruthy();
  });

  it('renders nothing without rows', () => {
    const { container } = render(<NodeUsage rows={[]} now={NOW} />);
    expect(container.textContent).toBe('');
  });
});
