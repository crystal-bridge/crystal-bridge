import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HeroManifest } from '../heroes.js';
import type { SessionInfo } from '../info.js';
import { LevelContext } from '../levels.js';
import { SessionPanel } from './SessionPanel.js';

const info: SessionInfo = {
  cwd: '/home/me/code/app/.worktrees/0123abcd',
  branch: 'cb/0123abcd',
  model: 'model-x',
  mode: 'auto',
  context: { used: 124_000, window: 200_000 },
  costUsd: 1.2345,
  stats: {
    tokens: { input: 1_234, output: 56_789, cacheRead: 2_400_000, cacheWrite: 310_000 },
    turns: 42,
    workingMs: 3_725_000,
  },
  outputs: [
    { path: '/home/me/code/app/src/app.ts', display: 'src/app.ts', kind: 'edited', changes: 3 },
    { path: '/home/me/code/app/src/new.ts', display: 'src/new.ts', kind: 'created', changes: 1 },
  ],
  tasks: [
    { id: 'a', kind: 'agent', description: 'Review the diff', running: true },
    { id: 'b', kind: 'background', description: 'Start the dev server', running: false },
  ],
};

describe('SessionPanel', () => {
  afterEach(() => cleanup());

  it('shows the Expedition: Kingdom, project, branch, model and mode', () => {
    render(<SessionPanel info={info} kingdom="node-b" />);
    expect(screen.getByRole('region', { name: 'Expedition' })).toBeTruthy();
    expect(screen.getByText('node-b')).toBeTruthy();
    expect(screen.getByText('/home/me/code/app/.worktrees/0123abcd')).toBeTruthy();
    expect(screen.getByText('cb/0123abcd')).toBeTruthy();
    expect(screen.getByText('model-x')).toBeTruthy();
    expect(screen.getByText('Auto')).toBeTruthy();
  });

  it('shows Stats: MP as the context left, Gold, tokens, turns, working time and data relayed', () => {
    render(<SessionPanel info={info} kingdom="node-b" relayedBytes={3_400_000} />);
    const stats = screen.getByRole('region', { name: 'Stats' });
    const value = (label: string) =>
      within(stats)
        .getByTitle(new RegExp(`^${label}`))
        .closest('div')?.textContent;
    expect(within(stats).getByRole('meter', { name: 'Context left' }).getAttribute('aria-valuenow')).toBe('38');
    expect(value('MP')).toContain('38% left');
    expect(value('MP')).toContain('124k of 200k');
    expect(value('Gold')).toMatch(/^Gold123/);
    expect(value('Tokens')).toContain('1.2k in');
    expect(value('Tokens')).toContain('57k out');
    expect(value('Tokens')).toContain('2.4M cache read');
    expect(value('Turns')).toContain('42');
    expect(value('Time')).toContain('1h 2m');
    expect(value('Relayed')).toContain('3.4 MB');
    expect(within(stats).getByTitle(/^Gold \(cost\)/)).toBeTruthy();
  });

  it('titles the game sections with menu-window plates, each in its own hue, and leaves the rest plain', () => {
    render(<SessionPanel info={info} kingdom="node-b" />);
    const plate = (name: string) => screen.getByRole('region', { name }).getAttribute('data-plate');
    expect(plate('Stats')).toBe('stats');
    expect(plate('Expedition')).toBe('expedition');
    expect(plate('Outputs')).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Stats' })).getByRole('heading').className).toContain('cb-plate');
  });

  it('puts Stats above the Expedition', () => {
    render(<SessionPanel info={info} kingdom="node-b" />);
    const names = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'));
    expect(names.indexOf('Stats')).toBeLessThan(names.indexOf('Expedition'));
  });

  it("shows HP above MP: the Kingdom's five-hour plan usage left, and when it rests", () => {
    const now = Date.UTC(2026, 9, 30, 12);
    const plan = [
      { id: 'seven_day', label: '7d', usedPct: 10, resetsAt: now + 86_400_000, status: 'allowed' },
      { id: 'five_hour', label: '5h', usedPct: 28, resetsAt: now + 72 * 60_000, status: 'allowed' },
    ];
    render(<SessionPanel info={info} kingdom="node-b" plan={plan} now={now} />);
    const stats = screen.getByRole('region', { name: 'Stats' });
    const hp = within(stats).getByRole('meter', { name: 'Plan left' });
    expect(hp.getAttribute('aria-valuenow')).toBe('72');
    expect(within(stats).getByTitle(/^HP/).closest('div')?.textContent).toContain('72% · rests in 1h12m');
    const meters = within(stats).getAllByRole('meter');
    expect(meters.indexOf(hp)).toBeLessThan(meters.indexOf(within(stats).getByRole('meter', { name: 'Context left' })));
  });

  it("says how old the Kingdom's report is once it's stale, since it only updates while a Quest runs there", () => {
    const now = Date.UTC(2026, 9, 30, 12);
    const plan = [{ id: 'five_hour', label: '5h', usedPct: 5, resetsAt: now + 27 * 60_000, status: 'allowed' }];
    render(<SessionPanel info={info} kingdom="node-b" plan={plan} planAt={now - 19 * 60_000} now={now} />);
    const hp = () => screen.getByTitle(/^HP/).closest('div')?.textContent;
    expect(hp()).toContain('95% · rests in 27m · as of 19m ago');
    cleanup();
    render(<SessionPanel info={info} kingdom="node-b" plan={plan} planAt={now - 60_000} now={now} />);
    expect(hp()).not.toContain('as of');
  });

  it('shows a full HP once the window has reset, and no HP without a plan report', () => {
    const now = Date.UTC(2026, 9, 30, 12);
    const plan = [{ id: 'five_hour', label: '5h', usedPct: 90, resetsAt: now - 1000, status: 'allowed' }];
    render(<SessionPanel info={info} kingdom="node-b" plan={plan} now={now} />);
    expect(screen.getByRole('meter', { name: 'Plan left' }).getAttribute('aria-valuenow')).toBe('100');
    cleanup();
    render(<SessionPanel info={info} kingdom="node-b" />);
    expect(screen.queryByRole('meter', { name: 'Plan left' })).toBeNull();
  });

  it('colours a meter in steps from full (green) to empty (red)', () => {
    const plan = (usedPct: number) => [{ id: 'five_hour', label: '5h', usedPct, resetsAt: null, status: 'allowed' }];
    const step = (usedPct: number) => {
      render(<SessionPanel info={info} kingdom="node-b" plan={plan(usedPct)} />);
      const value = screen.getByRole('meter', { name: 'Plan left' }).getAttribute('data-level');
      cleanup();
      return value;
    };
    expect([step(5), step(30), step(50), step(70), step(95)]).toEqual(['5', '4', '3', '2', '1']);
  });

  it('lists outputs with what happened to each, and tasks with whether they are still running', () => {
    render(<SessionPanel info={info} kingdom="node-b" />);
    expect(screen.getByText('src/app.ts').closest('li')?.textContent).toContain('edited ×3');
    expect(screen.getByText('src/new.ts').closest('li')?.textContent).toContain('created');
    expect(screen.getByText('Review the diff').closest('li')?.getAttribute('data-running')).toBe('true');
    expect(screen.getByText('Start the dev server').closest('li')?.getAttribute('data-running')).toBe('false');
  });

  it('says so when there is nothing yet', () => {
    render(
      <SessionPanel
        info={{
          costUsd: 0,
          stats: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, turns: 0, workingMs: 0 },
          outputs: [],
          tasks: [],
        }}
        kingdom="node-b"
      />,
    );
    expect(screen.getByText('No files changed yet')).toBeTruthy();
    expect(screen.getByText('None')).toBeTruthy();
  });

  it('shows the Party: the leader in its state, then each working subagent as a Hero of its matched Class', () => {
    const manifest: HeroManifest = {
      leader: 'paladin',
      fallback: 'wizard',
      classes: {
        paladin: { name: 'Paladin', match: [], work: 'slash', verb: 'Smite', victory: 'emote', anims: {} },
        wizard: {
          name: 'Wizard',
          match: [],
          work: 'spellcast',
          verb: 'Cast',
          victory: 'spellcast',
          anims: {},
        },
        rogue: { name: 'Rogue', match: ['explore'], work: 'slash', verb: 'Sneak', victory: 'emote', anims: {} },
      },
    };
    render(
      <SessionPanel
        info={{
          ...info,
          tasks: [
            { id: 'a', kind: 'agent', description: 'Map the repo', running: true, agentType: 'Explore' },
            { id: 'c', kind: 'agent', description: 'Old helper', running: false, agentType: 'Explore' },
            { id: 'd', kind: 'agent', description: 'Write the fix', running: true },
          ],
        }}
        kingdom="k"
        party={{ manifest, leaderState: 'working' }}
      />,
    );
    const party = screen.getByRole('region', { name: 'Party' });
    expect(party.textContent).toContain('Paladin');
    expect(screen.getByRole('img', { name: 'Paladin, Smite' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Rogue, Sneak' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Wizard, Cast' })).toBeTruthy();
    expect(party.textContent).toContain('Map the repo');
    expect(party.textContent).not.toContain('Old helper');
  });

  it('brings a companion along on each running Side Quest: the Owl on a Monitor', () => {
    const manifest: HeroManifest = {
      leader: 'paladin',
      fallback: 'paladin',
      classes: { paladin: { name: 'Paladin', match: [], work: 'slash', verb: 'Smite', victory: 'emote', anims: {} } },
    };
    render(
      <SessionPanel
        info={{
          ...info,
          tasks: [
            { id: 'm1', kind: 'monitor', description: 'Watch the deploy log', running: true },
            { id: 'b1', kind: 'background', description: 'Start the dev server', running: true },
            { id: 'b2', kind: 'background', description: 'Old build', running: false },
          ],
        }}
        kingdom="k"
        party={{ manifest, leaderState: 'working' }}
      />,
    );
    const party = screen.getByRole('region', { name: 'Party' });
    const companions = party.querySelectorAll('canvas[data-companion]');
    expect(companions).toHaveLength(2);
    expect(companions[0]!.getAttribute('data-companion')).toBe('owl');
    expect(screen.getByRole('img', { name: 'Owl, keeping watch' })).toBeTruthy();
    expect(party.textContent).toContain('Watch the deploy log');
    expect(party.textContent).toContain('Start the dev server');
    expect(party.textContent).not.toContain('Old build');
  });

  it("shows the party leader's level", () => {
    const manifest: HeroManifest = {
      leader: 'paladin',
      fallback: 'paladin',
      classes: { paladin: { name: 'Paladin', match: [], work: 'slash', verb: 'Smite', victory: 'emote', anims: {} } },
    };
    render(
      <LevelContext.Provider value={{ paladin: { level: 7, xp: 2200, into: 100, span: 700 } }}>
        <SessionPanel info={info} kingdom="k" party={{ manifest, leaderState: 'resting' }} />
      </LevelContext.Provider>,
    );
    expect(screen.getByRole('region', { name: 'Party' }).textContent).toContain('Paladin · Lv 7');
  });

  it('says in theme words what the party leader is doing, not its fixed Class verb', () => {
    const manifest = {
      leader: 'paladin',
      fallback: 'paladin',
      frame: { width: 64, height: 64 },
      classes: { paladin: { name: 'Paladin', match: [], work: 'slash', verb: 'Smite', victory: 'emote', anims: {} } },
    } as unknown as HeroManifest;
    render(
      <SessionPanel
        info={{
          ...info,
          tasks: [
            { id: 'a', kind: 'agent', running: true, description: 'Map the repo', agentType: 'Explore' },
            { id: 'b', kind: 'agent', running: true, description: 'Review it', agentType: 'reviewer' },
          ],
        }}
        kingdom="k"
        party={{ manifest, leaderState: 'working' }}
        activity={{ text: 'Editing src/a.ts', since: 1_234, kind: 'write' }}
        now={2_000}
      />,
    );
    const party = screen.getByRole('region', { name: 'Party' });
    expect(party.textContent).toMatch(/Party leader · (Forging|Inscribing)/);
    expect(party.textContent).not.toContain('Party leader · Smite');
    expect(party.textContent).toContain('Heroes on Side Quests: 2');
  });

  it('says what the party leader is doing and for how long, and flags a long silence', () => {
    const manifest = {
      leader: 'paladin',
      fallback: 'paladin',
      frame: { width: 64, height: 64 },
      classes: { paladin: { name: 'Paladin', match: [], work: 'slash', verb: 'Smite', victory: 'emote', anims: {} } },
    } as unknown as HeroManifest;
    const start = 1_000_000;
    const { rerender } = render(
      <SessionPanel
        info={info}
        kingdom="k"
        party={{ manifest, leaderState: 'working' }}
        activity={{ text: 'List processes on the box', since: start }}
        now={start + 90_000}
      />,
    );
    const party = screen.getByRole('region', { name: 'Party' });
    expect(party.textContent).toContain('List processes on the box');
    expect(party.textContent).toContain('1m');
    expect(party.textContent).not.toMatch(/No new output/);

    rerender(
      <SessionPanel
        info={info}
        kingdom="k"
        party={{ manifest, leaderState: 'working' }}
        activity={{ text: 'List processes on the box', since: start }}
        now={start + 6 * 60_000}
      />,
    );
    expect(screen.getByRole('region', { name: 'Party' }).textContent).toMatch(/No new output for 6m/);
  });

  it('shows the current step without the Heroes too', () => {
    render(<SessionPanel info={info} kingdom="k" activity={{ text: 'Thinking', since: 0 }} now={5_000} />);
    expect(screen.getByRole('region', { name: 'Now' }).textContent).toContain('Thinking');
  });

  it("ticks the step's time every second", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(100_000);
      render(<SessionPanel info={info} kingdom="k" activity={{ text: 'Thinking', since: 95_000 }} />);
      const now = () => screen.getByRole('region', { name: 'Now' }).textContent;
      expect(now()).toContain('5s');
      act(() => vi.advanceTimersByTime(1_000));
      expect(now()).toContain('6s');
    } finally {
      vi.useRealTimers();
    }
  });

  it('has no Party section without the Heroes', () => {
    render(<SessionPanel info={info} kingdom="k" />);
    expect(screen.queryByRole('region', { name: 'Party' })).toBeNull();
  });
});
