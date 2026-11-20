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

  it('shows the project each Quest works in', () => {
    renderStrip({ quests: [{ ...quests[0]!, cwd: '/r/app/.worktrees/4f2a' }] });
    const tab = screen.getByRole('tab', { name: /fix the build/ });
    expect(tab.querySelector('[data-project]')?.textContent).toBe('app');
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
  describe('pinned Boards', () => {
    const boards = [
      { id: 'gmail', name: 'Gmail', icon: 'mail', fresh: 3 },
      { id: 'github', name: 'GitHub', fresh: 4, warn: 'paused', reason: 'three failed runs' },
    ];

    it('sit between the Castle and the Quests, icon only, named for screen readers', () => {
      renderStrip({ boards, onBoard: vi.fn() });
      const tabs = screen.getAllByRole('tab');
      expect(tabs.slice(0, 3).map((t) => t.getAttribute('aria-label') ?? t.textContent)).toEqual([
        expect.stringContaining('Castle'),
        'Gmail, 3 new',
        'GitHub, paused',
      ]);
      const gmail = screen.getByRole('tab', { name: 'Gmail, 3 new' });
      expect(gmail.querySelector('svg.cb-icon')).not.toBeNull();
      expect(gmail.querySelector('[data-fresh]')?.textContent).toBe('3');
      // No icon named: the name's first letter stands in.
      expect(screen.getByRole('tab', { name: /^GitHub/ }).textContent).toContain('G');
      // A stopped Scout's dot stands in for its count.
      const github = screen.getByRole('tab', { name: /^GitHub/ });
      expect(github.querySelector('[data-warn]')).not.toBeNull();
      expect(github.querySelector('[data-fresh]')).toBeNull();
      // Wide screens only, like the Board page.
      expect(document.querySelector('[data-pinned]')!.className).toMatch(/\bhidden\b.*\bmd:flex\b/);
    });

    it('caps a long count, and has no group without a way to open a Board', () => {
      renderStrip({ boards: [{ id: 'gmail', name: 'Gmail', fresh: 250 }], onBoard: vi.fn() });
      expect(document.querySelector('[data-fresh]')?.textContent).toBe('99+');
      cleanup();
      renderStrip({ boards });
      expect(document.querySelector('[data-pinned]')).toBeNull();
    });

    it("names a Board's tab in a themed tooltip, with why its Scout stopped", () => {
      renderStrip({ boards, onBoard: vi.fn() });
      const github = screen.getByRole('tab', { name: /^GitHub/ });
      expect(github.getAttribute('title')).toBeNull();
      const tip = document.getElementById(github.getAttribute('aria-describedby')!);
      expect(tip?.textContent).toBe('GitHub · paused: three failed runs');
    });

    it("opens a Board and marks its tab while it's open, not the Castle's", () => {
      const props = renderStrip({ boards, onBoard: vi.fn(), currentBoard: 'gmail' });
      expect(screen.getByRole('tab', { name: /^Gmail/ }).getAttribute('aria-selected')).toBe('true');
      expect(screen.getByRole('tab', { name: /Castle/ }).getAttribute('aria-selected')).toBe('false');
      fireEvent.click(screen.getByRole('tab', { name: /^GitHub/ }));
      expect(props.onBoard).toHaveBeenCalledWith('github');
    });

    it('has no close button, and unpins from its right-click menu', () => {
      const onUnpin = vi.fn();
      renderStrip({ boards, onBoard: vi.fn(), onUnpin });
      expect(screen.queryByRole('button', { name: /Put away Gmail/ })).toBeNull();
      fireEvent.contextMenu(screen.getByRole('tab', { name: /^Gmail/ }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Unpin from tab strip' }));
      expect(onUnpin).toHaveBeenCalledWith('gmail');
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('closes the menu on Escape without unpinning', () => {
      const onUnpin = vi.fn();
      renderStrip({ boards, onBoard: vi.fn(), onUnpin });
      fireEvent.contextMenu(screen.getByRole('tab', { name: /^Gmail/ }));
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
      expect(screen.queryByRole('menu')).toBeNull();
      expect(onUnpin).not.toHaveBeenCalled();
      // Focus goes back to the tab it was opened from.
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: /^Gmail/ }));
    });

    it('closes the menu on a click elsewhere, or when focus leaves it', () => {
      renderStrip({ boards, onBoard: vi.fn(), onUnpin: vi.fn() });
      fireEvent.contextMenu(screen.getByRole('tab', { name: /^Gmail/ }));
      fireEvent.pointerDown(document.body);
      expect(screen.queryByRole('menu')).toBeNull();
      fireEvent.contextMenu(screen.getByRole('tab', { name: /^Gmail/ }));
      fireEvent.blur(screen.getByRole('menuitem'), { relatedTarget: document.body });
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it("doesn't take focus back when the strip draws again with the menu open", () => {
      const props = {
        castleName: 'Castle',
        quests,
        current: 'castle',
        waiting: new Set<string>(),
        onCastle: vi.fn(),
        onSelect: vi.fn(),
        onPutAway: vi.fn(),
        onNew: vi.fn(),
        boards,
        onBoard: vi.fn(),
      };
      // A new arrow each draw, as App passes it.
      const { rerender } = render(<QuestStrip {...props} onUnpin={() => {}} />);
      fireEvent.contextMenu(screen.getByRole('tab', { name: /^Gmail/ }));
      const castle = screen.getByRole('tab', { name: /Castle/ });
      castle.focus();
      rerender(<QuestStrip {...props} waiting={new Set(['a'])} onUnpin={() => {}} />);
      expect(document.activeElement).toBe(castle);
    });

    it('reorder among themselves with Alt+Arrow', () => {
      const onMoveBoard = vi.fn();
      renderStrip({ boards, onBoard: vi.fn(), onMoveBoard });
      fireEvent.keyDown(screen.getByRole('tab', { name: /^Gmail/ }), { key: 'ArrowRight', altKey: true });
      expect(onMoveBoard).toHaveBeenCalledWith('gmail', 1);
    });
  });

  describe('naming a Quest', () => {
    it('shows the name a Quest gave itself', () => {
      renderStrip({ quests: [{ ...quests[0]!, themedLabel: 'The Siege of the Build' }] });
      expect(screen.getByRole('tab', { name: /The Siege of the Build/ })).toBeTruthy();
    });

    it('renames a Quest from its tab’s menu', () => {
      const onRename = vi.fn();
      renderStrip({ onRename });
      fireEvent.contextMenu(screen.getByRole('tab', { name: /fix the build/ }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
      const box = screen.getByRole('textbox', { name: /Rename/ }) as HTMLInputElement;
      expect(box.value).toBe('fix the build');
      fireEvent.change(box, { target: { value: '  Build fix  ' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(onRename).toHaveBeenCalledWith('a', 'Build fix');
      expect(screen.queryByRole('textbox')).toBeNull();
    });

    it('leaves the name alone on Escape, or when nothing is typed', () => {
      const onRename = vi.fn();
      renderStrip({ onRename });
      fireEvent.contextMenu(screen.getByRole('tab', { name: /fix the build/ }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
      fireEvent.contextMenu(screen.getByRole('tab', { name: /fix the build/ }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
      const box = screen.getByRole('textbox');
      fireEvent.change(box, { target: { value: '   ' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(onRename).not.toHaveBeenCalled();
    });

    it('offers no Rename for a closed Quest, which can’t be renamed', () => {
      renderStrip({ onRename: vi.fn(), quests: [{ ...quests[0]!, status: 'closed' }] });
      fireEvent.contextMenu(screen.getByRole('tab', { name: /fix the build/ }));
      expect(screen.queryByRole('menuitem', { name: 'Rename' })).toBeNull();
    });

    it('offers no menu on a Quest tab when renaming isn’t wired', () => {
      renderStrip();
      fireEvent.contextMenu(screen.getByRole('tab', { name: /fix the build/ }));
      expect(screen.queryByRole('menu')).toBeNull();
    });
  });
});
