import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionList, type SessionSummary } from './SessionList.js';

const s = (id: string, label: string, status: SessionSummary['status']): SessionSummary => ({
  id,
  node: 'n',
  cwd: '/w',
  label,
  status,
  createdAt: 0,
});

describe('SessionList', () => {
  afterEach(() => cleanup());

  it('hides closed sessions until asked', () => {
    render(
      <SessionList
        sessions={[s('a', 'Open one', 'idle'), s('b', 'Done one', 'closed')]}
        selected={null}
        onSelect={vi.fn()}
        onNew={vi.fn()}
      />,
    );
    expect(screen.queryByText('Done one')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 closed' }));
    expect(screen.getByText('Done one')).toBeTruthy();
    expect(screen.getByText('Open one')).toBeTruthy();
  });

  it('shows each session-s folder name and age, and marks ones waiting on you', () => {
    const now = 1_800_000_000_000;
    const sessions = [
      { ...s('a', 'Fix the login test', 'running'), cwd: '/home/me/code/app', createdAt: now - 3 * 3_600_000 },
      { ...s('b', 'Write docs', 'idle'), createdAt: now - 5 * 60_000 },
    ];
    render(
      <SessionList
        sessions={sessions}
        selected={null}
        onSelect={vi.fn()}
        onNew={vi.fn()}
        waiting={new Set(['a'])}
        now={now}
      />,
    );
    const first = screen.getByText('Fix the login test').closest('button')!;
    expect(first.textContent).toContain('app · 3h');
    expect(first.querySelector('[data-waiting]')?.textContent).toBe('needs you');
    expect(screen.getByText('Write docs').closest('button')!.querySelector('[data-waiting]')).toBeNull();
  });
});
