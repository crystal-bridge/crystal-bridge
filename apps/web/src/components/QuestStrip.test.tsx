import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type HeroManifest, LeaderContext } from '../heroes.js';
import type { SessionSummary } from './SessionList.js';
import { QuestStrip } from './QuestStrip.js';

const quests: SessionSummary[] = [
  { id: 'a', node: 'k', cwd: '/r/app', label: 'fix the build', status: 'running', createdAt: 1 },
  { id: 'b', node: 'k', cwd: '/r/app', label: 'write docs', status: 'idle', createdAt: 2 },
];

function renderStrip(overrides: Partial<Parameters<typeof QuestStrip>[0]> = {}) {
  const props = {
    castleName: 'Castle',
    quests,
    current: 'castle' as 'castle' | 'new' | string,
    waiting: new Set<string>(),
    onCastle: vi.fn(),
    onSelect: vi.fn(),
    onPutAway: vi.fn(),
    onNew: vi.fn(),
    ...overrides,
  };
  render(<QuestStrip {...props} />);
  return props;
}

describe('QuestStrip', () => {
  afterEach(() => cleanup());

  it('shows the Castle first, a tab per Quest, then New Quest', () => {
    renderStrip();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([
      expect.stringContaining('Castle'),
      expect.stringContaining('fix the build'),
      expect.stringContaining('write docs'),
      expect.stringContaining('New Quest'),
    ]);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
  });

  it('marks the shown Quest and the ones waiting on you', () => {
    renderStrip({ current: 'b', waiting: new Set(['a']) });
    expect(screen.getByRole('tab', { name: /write docs/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /fix the build/ }).querySelector('[data-waiting]')).not.toBeNull();
  });

  it('opens the Castle, a Quest or a new one', () => {
    const props = renderStrip({ current: 'a' });
    fireEvent.click(screen.getByRole('tab', { name: /write docs/ }));
    expect(props.onSelect).toHaveBeenCalledWith('b');
    fireEvent.click(screen.getByRole('tab', { name: /Castle/ }));
    expect(props.onCastle).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: /New Quest/ }));
    expect(props.onNew).toHaveBeenCalled();
  });

  it('puts a Quest away without opening it', () => {
    const props = renderStrip();
    fireEvent.click(screen.getByRole('button', { name: 'Put away fix the build' }));
    expect(props.onPutAway).toHaveBeenCalledWith('a');
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('moves a Quest tab with Alt+Arrow keys', () => {
    const onMove = vi.fn();
    renderStrip({ onMove });
    fireEvent.keyDown(screen.getByRole('tab', { name: /fix the build/ }), { key: 'ArrowRight', altKey: true });
    expect(onMove).toHaveBeenCalledWith('a', 1);
    fireEvent.keyDown(screen.getByRole('tab', { name: /write docs/ }), { key: 'ArrowLeft', altKey: true });
    expect(onMove).toHaveBeenCalledWith('b', 0);
    fireEvent.keyDown(screen.getByRole('tab', { name: /write docs/ }), { key: 'ArrowLeft' });
    expect(onMove).toHaveBeenCalledTimes(2);
  });

  it('moves a Quest tab by dragging it onto another', () => {
    const onMove = vi.fn();
    renderStrip({ onMove });
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (k: string, v: string) => data.set(k, v),
      getData: (k: string) => data.get(k) ?? '',
      effectAllowed: '',
      dropEffect: '',
    };
    fireEvent.dragStart(screen.getByRole('tab', { name: /write docs/ }), { dataTransfer });
    fireEvent.dragOver(screen.getByRole('tab', { name: /fix the build/ }), { dataTransfer });
    fireEvent.drop(screen.getByRole('tab', { name: /fix the build/ }), { dataTransfer });
    expect(onMove).toHaveBeenCalledWith('b', 0);
  });

  it('draws each Quest-s party leader in its state when the Heroes are loaded, else a status dot', () => {
    const manifest: HeroManifest = {
      leader: 'paladin',
      fallback: 'paladin',
      classes: {
        paladin: { name: 'Paladin', match: [], work: 'slash', verb: 'Smite', victory: 'emote', anims: {} },
      },
    };
    renderStrip({ heroes: { manifest, states: { a: 'working', b: 'alert' } } });
    const leaders = document.querySelectorAll('canvas[data-class="paladin"]');
    expect([...leaders].map((c) => c.getAttribute('data-state'))).toEqual(['working', 'alert']);
    // Decorative inside the tab: the tab-s name stays the Quest-s label.
    expect(screen.getByRole('tab', { name: 'fix the build' })).toBeTruthy();
    cleanup();
    renderStrip();
    expect(document.querySelector('canvas')).toBeNull();
  });

  it('draws the Class the Kingdom chose to lead each Quest', () => {
    const manifest: HeroManifest = {
      leader: 'paladin',
      fallback: 'paladin',
      classes: {
        paladin: { name: 'Paladin', match: [], work: 'slash', verb: 'Smite', victory: 'emote', anims: {} },
        rogue: { name: 'Rogue', match: [], work: 'slash', verb: 'Sneak', victory: 'emote', anims: {} },
      },
    };
    render(
      <LeaderContext.Provider value={(quest) => (quest === 'b' ? 'rogue' : undefined)}>
        <QuestStrip
          castleName="Castle"
          quests={quests}
          current="castle"
          waiting={new Set()}
          onCastle={vi.fn()}
          onSelect={vi.fn()}
          onPutAway={vi.fn()}
          onNew={vi.fn()}
          heroes={{ manifest, states: {} }}
        />
      </LeaderContext.Provider>,
    );
    expect([...document.querySelectorAll('canvas')].map((c) => c.getAttribute('data-class'))).toEqual([
      'paladin',
      'rogue',
    ]);
  });
});
