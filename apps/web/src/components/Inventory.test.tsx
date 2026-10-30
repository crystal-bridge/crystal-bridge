import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Inventory as InventoryData } from '../inventory.js';
import { Inventory } from './Inventory.js';

const inventory: InventoryData = {
  spells: [{ category: 'spells', name: 'code-review', use: '/code-review ' }],
  items: [
    { category: 'items', name: 'compact', use: '/compact ' },
    { category: 'items', name: 'clear', use: '/clear ' },
  ],
  equipment: [
    { category: 'equipment', name: 'github', detail: 'MCP server · user', status: 'ok' },
    { category: 'equipment', name: 'flaky', detail: 'MCP server · project', status: 'failed' },
  ],
  abilities: [{ category: 'abilities', name: 'SessionStart:startup', detail: 'SessionStart', status: 'ok' }],
};

describe('Inventory', () => {
  afterEach(() => cleanup());

  it('groups entries under Spells, Items, Equipment and Abilities, with Abilities folded away', () => {
    render(<Inventory inventory={inventory} onUse={vi.fn()} />);
    for (const name of [/^Spells/, /^Items/, /^Equipment/]) expect(screen.getByRole('heading', { name })).toBeTruthy();
    const abilities = screen.getByText('Abilities').closest('details')!;
    expect(abilities.open).toBe(false);
  });

  it('marks each category with its themed icon', () => {
    const { container } = render(<Inventory inventory={inventory} onUse={vi.fn()} />);
    for (const name of ['spells', 'items', 'equipment', 'abilities']) {
      expect(container.querySelector(`[data-icon='${name}'] svg`)?.classList.contains(`cb-icon-${name}`)).toBe(true);
    }
  });

  it('explains each category in a themed tooltip, not the browser title', () => {
    const { container } = render(<Inventory inventory={inventory} onUse={vi.fn()} />);
    expect(container.querySelector('h3[title], h3 [title], summary[title], summary [title]')).toBeNull();
    expect(screen.getAllByRole('tooltip', { hidden: true })).toHaveLength(4);
  });

  it('uses a Spell or Item by handing over its prompt text', () => {
    const onUse = vi.fn();
    render(<Inventory inventory={inventory} onUse={onUse} />);
    fireEvent.click(screen.getByRole('button', { name: /code-review/ }));
    expect(onUse).toHaveBeenCalledWith('/code-review ');
    fireEvent.click(screen.getByRole('button', { name: /compact/ }));
    expect(onUse).toHaveBeenCalledWith('/compact ');
  });

  it('shows whether each piece of Equipment works, and can-t be used by hand', () => {
    render(<Inventory inventory={inventory} onUse={vi.fn()} />);
    const equipment = screen.getByRole('region', { name: 'Equipment' });
    expect(within(equipment).queryAllByRole('button')).toHaveLength(0);
    expect(within(equipment).getByText('flaky').closest('li')!.getAttribute('data-status')).toBe('failed');
  });

  it('notes that account connectors arrive after the first turn until one is listed', () => {
    render(<Inventory inventory={inventory} onUse={vi.fn()} />);
    expect(screen.getByText(/connectors.*after the first turn/i)).toBeTruthy();
    cleanup();
    const withConnector: InventoryData = {
      ...inventory,
      equipment: [{ category: 'equipment', name: 'claude.ai Gmail', detail: 'MCP server · claudeai', status: 'ok' }],
    };
    render(<Inventory inventory={withConnector} onUse={vi.fn()} />);
    expect(screen.queryByText(/connectors.*after the first turn/i)).toBeNull();
  });

  it('filters by search', () => {
    render(<Inventory inventory={inventory} onUse={vi.fn()} />);
    fireEvent.change(screen.getByRole('searchbox', { name: /Search/ }), { target: { value: 'cle' } });
    expect(screen.getByRole('button', { name: /clear/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /compact/ })).toBeNull();
  });

  it('says what will appear before the engine reports anything', () => {
    render(<Inventory inventory={{ spells: [], items: [], equipment: [], abilities: [] }} onUse={vi.fn()} />);
    expect(screen.getByText(/appears once the Quest starts/)).toBeTruthy();
  });
});
