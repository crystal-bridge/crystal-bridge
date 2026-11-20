import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Airship } from './Airship.js';
import type { SessionSummary } from './SessionList.js';

const NOW = 1_000_000_000;
const kingdoms = [
  { id: 'dev', name: 'Workshop', connected: true, sessions: 2 },
  { id: 'quiet', name: 'Lantern', connected: false, sessions: 1 },
];
const sessions: SessionSummary[] = [
  { id: 'a', node: 'dev', cwd: '/r', label: 'fix the build', status: 'running', createdAt: 1, lastActivity: NOW },
  { id: 'b', node: 'dev', cwd: '/r', label: 'old', status: 'idle', createdAt: 0, lastActivity: 0 },
  { id: 'c', node: 'quiet', cwd: '/q', label: 'private matter', status: 'idle', createdAt: 0, lastActivity: NOW },
];

function renderAirship(overrides: Partial<Parameters<typeof Airship>[0]> = {}) {
  const props = {
    kingdoms,
    sessions,
    waiting: { a: 'dev', c: 'quiet' } as Record<string, string>,
    usage: [],
    notify: { quiet: 'discreet' } as Record<string, 'full' | 'discreet' | 'off'>,
    onKingdom: vi.fn(),
    onQuest: vi.fn(),
    now: NOW,
    ...overrides,
  };
  render(<Airship {...props} />);
  return props;
}

describe('Airship', () => {
  afterEach(() => cleanup());

  it('uses the width it has: Kingdoms and tiles wrap to fit instead of squeezing', () => {
    renderAirship();
    expect(document.querySelector('.max-w-3xl')).toBeNull();
    expect(screen.getByRole('region', { name: 'Kingdoms' }).className).toContain('auto-fit');
    expect(screen.getByRole('region', { name: 'Today' }).querySelector('dl')?.className).toContain('auto-fit');
  });

  it('lists what is waiting on you in the Tavern, with no titles from Discreet Kingdoms', () => {
    const props = renderAirship();
    const tavern = screen.getByRole('region', { name: 'Tavern' });
    expect(tavern.textContent).toContain('fix the build');
    expect(tavern.textContent).toContain('Lantern: a Quest needs you');
    expect(screen.queryByText(/private matter/)).toBeNull();

    fireEvent.click(screen.getByText('Lantern: a Quest needs you'));
    expect(props.onQuest).toHaveBeenCalledWith('quiet', 'c');
  });

  it('lists finished Quests you have not seen after what needs you, newest first, with no titles from Discreet Kingdoms', () => {
    const props = renderAirship({
      waiting: { a: 'dev' },
      unseen: {
        b: { node: 'dev', reason: 'done', at: NOW - 5_000 },
        c: { node: 'quiet', reason: 'failed', at: NOW - 1_000 },
      },
    });
    const rows = within(screen.getByRole('region', { name: 'Tavern' })).getAllByRole('button');
    expect(rows.map((row) => row.textContent)).toEqual([
      '!Workshop: fix the build',
      expect.stringContaining('Lantern: a Quest failed'),
      expect.stringContaining('Workshop: old'),
    ]);
    // Failed carries a shape as well as its colour; finished is a plain dot.
    expect(rows[1]!.querySelector('[data-unseen="failed"]')?.textContent).toBe('×');
    expect(rows[2]!.querySelector('[data-unseen="done"]')?.textContent).toBe('');
    expect(screen.queryByText(/private matter/)).toBeNull();
    fireEvent.click(rows[2]!);
    expect(props.onQuest).toHaveBeenCalledWith('dev', 'b');
  });

  it('lists a Kingdom-s Quests on its card by attention, marking finished ones you have not seen', () => {
    renderAirship({
      waiting: {},
      unseen: { b: { node: 'dev', reason: 'done', at: NOW } },
    });
    const workshop = document.querySelector('[data-kingdom="dev"]') as HTMLElement;
    expect(workshop.textContent).toContain('2 active');
    const titles = [...workshop.querySelectorAll('li')].map((li) => li.textContent);
    expect(titles[0]).toContain('old');
    expect(titles[1]).toContain('fix the build');
    expect(workshop.querySelector('[data-unseen="done"]')).not.toBeNull();
  });

  it('shows each Kingdom card with its icon and colour', () => {
    const props = renderAirship({ looks: { quiet: { icon: 'ship', colour: '#1f9aa6' } } });
    const card = document.querySelector('[data-kingdom="quiet"]') as HTMLElement;
    expect(card.querySelector('svg')!.getAttribute('data-icon')).toBe('ship');
    expect(card.style.getPropertyValue('--kingdom-colour')).toBe('#1f9aa6');
    expect(props.kingdoms.length).toBeGreaterThan(0);
  });

  it('says so when nothing is waiting', () => {
    renderAirship({ waiting: {}, unseen: {} });
    expect(screen.getByText('Nothing is waiting on you.')).toBeTruthy();
  });

  it('shows a card per Kingdom with its active Quests, and opens its Castle', () => {
    const props = renderAirship();
    const cards = within(screen.getByRole('region', { name: 'Kingdoms' }));
    const card = cards.getByRole('button', { name: /Workshop/ });
    expect(card.textContent).toContain('1 active');
    expect(cards.getByRole('button', { name: /Lantern/ }).textContent).toContain('offline');
    fireEvent.click(card);
    expect(props.onKingdom).toHaveBeenCalledWith('dev');
  });

  it('lists each Kingdom-s active Quests on its card, with no titles from a Discreet one, and starts a New Quest there', () => {
    const props = renderAirship({ onNewQuest: vi.fn() });
    const workshop = document.querySelector('[data-kingdom="dev"]') as HTMLElement;
    expect(workshop.textContent).toContain('fix the build');
    const lantern = document.querySelector('[data-kingdom="quiet"]') as HTMLElement;
    expect(lantern.textContent).not.toContain('private matter');
    fireEvent.click(within(workshop).getByRole('button', { name: 'New Quest on Workshop' }));
    expect(props.onNewQuest).toHaveBeenCalledWith('dev');
  });

  it('totals today across the Kingdoms this device shows', () => {
    const row = (node: string, costUsd: number) => ({
      node,
      turns: 1,
      kos: 0,
      costUsd,
      durationMs: 1000,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    renderAirship({ today: [row('dev', 1), row('quiet', 0.5), row('hidden', 100)] });
    expect(screen.getByRole('region', { name: 'Today' }).textContent).toContain('$1.50');
  });

  it('keeps an adventure log of recent activity, naming no Quest from a Discreet Kingdom', () => {
    renderAirship({
      activity: [
        { session: 'a', node: 'dev', label: 'fix the build', ts: NOW - 60_000, kind: 'turn', outcome: 'success' },
        { session: 'c', node: 'quiet', label: 'private matter', ts: NOW - 120_000, kind: 'closed' },
        { session: 'z', node: 'hidden', label: 'secret', ts: NOW, kind: 'started' },
      ],
    });
    const log = screen.getByRole('region', { name: 'Adventure log' });
    expect(log.textContent).toContain('Workshop: “fix the build” finished a turn');
    expect(log.textContent).toContain('Lantern: a Quest was completed');
    expect(log.textContent).not.toContain('private matter');
    expect(log.textContent).not.toContain('secret');
  });
});
