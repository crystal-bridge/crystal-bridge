import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RECENT_MS } from '../quests.js';
import { Castle } from './Castle.js';
import type { SessionSummary } from './SessionList.js';

const NOW = 100 * RECENT_MS;
const sessions: SessionSummary[] = [
  { id: 'a', node: 'k', cwd: '/r', label: 'fix the build', status: 'running', createdAt: 3, lastActivity: NOW },
  { id: 'b', node: 'k', cwd: '/r', label: 'answer me', status: 'idle', createdAt: 2, lastActivity: NOW - 1000 },
  { id: 'c', node: 'k', cwd: '/r', label: 'old work', status: 'idle', createdAt: 1, lastActivity: 0 },
];

function renderCastle(overrides: Partial<Parameters<typeof Castle>[0]> = {}) {
  const props = {
    kingdom: { id: 'k', name: 'Lantern', connected: true, sessions: 3 },
    sessions,
    waiting: new Set(['b']),
    usage: [],
    found: [],
    onAdopt: vi.fn(),
    onSelect: vi.fn(),
    onNew: vi.fn(),
    query: '',
    onQuery: vi.fn(),
    hits: [],
    onOpenHit: vi.fn(),
    now: NOW,
    ...overrides,
  };
  render(<Castle {...props} />);
  return props;
}

describe('Castle', () => {
  afterEach(() => cleanup());

  it('puts what needs you first, then the active Quests, and keeps old ones in the closed Chronicle', () => {
    renderCastle();
    const needs = screen.getByRole('region', { name: 'Needs you' });
    expect(needs.textContent).toContain('answer me');
    const active = screen.getByRole('region', { name: 'Active Quests' });
    expect(active.textContent).toContain('fix the build');
    expect(active.textContent).not.toContain('answer me');
    expect(screen.queryByText('old work')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Chronicle/ }));
    expect(screen.getByText('old work')).toBeTruthy();
    expect(screen.getByPlaceholderText('Search this Kingdom')).toBeTruthy();
  });

  it('flies the Kingdom-s banner: its icon and colour in the header', () => {
    renderCastle({ look: { icon: 'fortress', colour: '#2f9e5a' } });
    const header = screen.getByRole('banner');
    expect(header.querySelector('svg')!.getAttribute('data-icon')).toBe('fortress');
    expect(header.style.getPropertyValue('--kingdom-colour')).toBe('#2f9e5a');
  });

  it('opens a Quest, or starts a new one', () => {
    const props = renderCastle();
    fireEvent.click(screen.getByText('fix the build'));
    expect(props.onSelect).toHaveBeenCalledWith('a');
    fireEvent.click(screen.getByRole('button', { name: 'New Quest' }));
    expect(props.onNew).toHaveBeenCalled();
  });

  it('keeps Recruits (sessions found outside the bridge) folded away until asked', () => {
    renderCastle({
      found: [{ id: 'x', cwd: '/r', title: 'terminal work', messages: 4, updatedAt: 0 }],
    });
    expect(screen.queryByText('terminal work')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Recruits/ }));
    expect(screen.getByText('terminal work')).toBeTruthy();
  });

  it('shows the Kingdom-s release and engines, and its totals for today and this week', () => {
    const stats = (turns: number, costUsd: number) => ({
      node: 'k',
      turns,
      kos: 0,
      costUsd,
      durationMs: 60_000,
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    renderCastle({
      release: '0123456789ab',
      engines: ['stream', 'interactive'],
      today: stats(2, 0.5),
      week: stats(9, 3.25),
    });
    expect(screen.getByRole('banner').textContent).toContain('0123456');
    expect(screen.getByRole('banner').textContent).toMatch(/interactive/);
    expect(screen.getByRole('region', { name: 'Today' }).textContent).toContain('$0.50');
    expect(screen.getByRole('region', { name: 'This week' }).textContent).toContain('$3.25');
  });

  it('shows a version whole, and says when the Kingdom is behind the Airship', () => {
    renderCastle({ release: '0.2.0-alpha.1', hubRelease: '0.3.0' });
    expect(screen.getByRole('banner').textContent).toContain('0.2.0-alpha.1');
    expect(screen.getByRole('status').textContent).toContain('0.3.0');
  });

  it('stays quiet when the Kingdom is up to date', () => {
    renderCastle({ release: '0.3.0', hubRelease: '0.3.0' });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows active Quests as cards with the start of their latest reply', () => {
    renderCastle({ sessions: [{ ...sessions[0]!, preview: 'All tests pass now.' }, ...sessions.slice(1)] });
    expect(screen.getByRole('region', { name: 'Active Quests' }).textContent).toContain('All tests pass now.');
  });

  it('lists the most-used folders, each starting a New Quest there', () => {
    const props = renderCastle({
      onNewIn: vi.fn(),
      sessions: [
        ...sessions,
        { id: 'd', node: 'k', cwd: '/w/docs', label: 'docs', status: 'closed', createdAt: 4, lastActivity: 0 },
      ],
    });
    const haunts = screen.getByRole('region', { name: 'Haunts' });
    expect(haunts.textContent).toContain('r');
    expect(haunts.textContent).toContain('docs');
    fireEvent.click(screen.getByRole('button', { name: 'Set out here: docs' }));
    expect(props.onNewIn).toHaveBeenCalledWith('/w/docs');
  });
});
