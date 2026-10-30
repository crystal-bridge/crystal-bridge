import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KingdomBar } from './KingdomBar.js';

const visible = [
  { id: 'node-b', name: 'node-b', connected: true, sessions: 2 },
  { id: 'node-a', name: 'Lantern', connected: false, sessions: 0 },
];

function renderBar(overrides: Partial<Parameters<typeof KingdomBar>[0]> = {}) {
  const props = {
    visible,
    active: 'node-b' as string | null,
    onSelect: vi.fn(),
    waiting: {} as Record<string, number>,
    ...overrides,
  };
  render(<KingdomBar {...props} />);
  return props;
}

describe('KingdomBar', () => {
  afterEach(() => cleanup());

  it('shows a tab per visible Kingdom and marks the active one', () => {
    renderBar();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      expect.stringContaining('node-b'),
      expect.stringContaining('Lantern'),
    ]);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('false');
  });

  it('draws each tab with its Kingdom-s icon and colour, in this device-s tab style', () => {
    renderBar({
      looks: { 'node-b': { icon: 'castle', colour: '#3550c8' }, 'node-a': { icon: 'spire', colour: '#8a4fd0' } },
      tabStyle: 'tinted',
    });
    expect(screen.getByRole('tablist').getAttribute('data-tab-style')).toBe('tinted');
    const [first, second] = screen.getAllByRole('tab');
    expect(first!.querySelector('svg')!.getAttribute('data-icon')).toBe('castle');
    // The theme gives icons a halo on dark backgrounds, where their dark outline would vanish.
    expect(first!.querySelector('svg')!.classList.contains('cb-kingdom-icon')).toBe(true);
    expect(first!.style.getPropertyValue('--kingdom-colour')).toBe('#3550c8');
    expect(second!.querySelector('svg')!.getAttribute('data-icon')).toBe('spire');
  });

  it('selects no tab while the Airship is shown', () => {
    renderBar({ active: null });
    expect(screen.getAllByRole('tab').every((tab) => tab.getAttribute('aria-selected') === 'false')).toBe(true);
  });

  it('shows whether each Kingdom is connected', () => {
    renderBar();
    expect(screen.getByRole('tab', { name: /node-b/ }).querySelector('[data-connected="true"]')).not.toBeNull();
    expect(screen.getByRole('tab', { name: /Lantern/ }).querySelector('[data-connected="false"]')).not.toBeNull();
  });

  it('selects a Kingdom on click', () => {
    const props = renderBar();
    fireEvent.click(screen.getByRole('tab', { name: /Lantern/ }));
    expect(props.onSelect).toHaveBeenCalledWith('node-a');
  });

  it('shows how many Quests are waiting on the user in each tab', () => {
    renderBar({ waiting: { 'node-a': 2 } });
    expect(screen.getByRole('tab', { name: /Lantern/ }).textContent).toContain('2');
  });

  it('moves a Kingdom tab with Alt+Arrow keys, or by dragging it onto another', () => {
    const onMove = vi.fn();
    renderBar({ onMove });
    fireEvent.keyDown(screen.getByRole('tab', { name: /node-b/ }), { key: 'ArrowRight', altKey: true });
    expect(onMove).toHaveBeenCalledWith('node-b', 1);

    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (k: string, v: string) => data.set(k, v),
      getData: (k: string) => data.get(k) ?? '',
      effectAllowed: '',
      dropEffect: '',
    };
    fireEvent.dragStart(screen.getByRole('tab', { name: /Lantern/ }), { dataTransfer });
    fireEvent.drop(screen.getByRole('tab', { name: /node-b/ }), { dataTransfer });
    expect(onMove).toHaveBeenCalledWith('node-a', 0);
  });
});
