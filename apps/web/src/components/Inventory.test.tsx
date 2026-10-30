import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BELT_SIZE, type Belt, type BeltSlot } from '../belt.js';
import type { HeroManifest } from '../heroes.js';
import { emptyInventory, type Inventory as InventoryData } from '../inventory.js';
import { Inventory, type InventoryProps } from './Inventory.js';

const inventory: InventoryData = {
  spells: [
    { category: 'spells', name: 'code-review', use: '/code-review ' },
    { category: 'spells', name: 'forge:deploy', use: '/forge:deploy ' },
  ],
  items: [
    { category: 'items', name: 'compact', use: '/compact ' },
    { category: 'items', name: 'clear', use: '/clear ' },
  ],
  equipment: [
    { category: 'equipment', name: 'github', use: 'Use the github tools to ', detail: '2 tools · user', status: 'ok' },
    { category: 'equipment', name: 'flaky', use: 'Use the flaky tools to ', detail: 'MCP server', status: 'failed' },
    { category: 'equipment', name: 'sentry', use: 'Use the sentry tools to ', status: 'needs-auth' },
  ],
  relics: [{ category: 'relics', name: 'forge', detail: 'plugin 2.1.0' }],
  guild: [{ category: 'guild', name: 'code-reviewer', use: 'Use the code-reviewer agent to ' }],
  abilities: [{ category: 'abilities', name: 'SessionStart:startup', detail: 'SessionStart', status: 'ok' }],
};

const manifest: HeroManifest = {
  leader: 'paladin',
  fallback: 'wizard',
  classes: {
    cleric: {
      name: 'Cleric',
      match: ['review'],
      work: 'spellcast',
      verb: 'Heal',
      victory: 'spellcast',
      anims: { idle: { frames: 2, size: 64 } },
    },
    wizard: {
      name: 'Wizard',
      match: [],
      work: 'spellcast',
      verb: 'Cast',
      victory: 'spellcast',
      anims: { idle: { frames: 2, size: 64 } },
    },
  },
};

function belt(...slots: Belt): Belt {
  return [...slots, ...Array<null>(BELT_SIZE - slots.length).fill(null)];
}

const deploy: BeltSlot = { label: 'deploy', text: '/deploy ', icon: 'rocket' };
const compact: BeltSlot = { label: 'compact', text: '/compact ', icon: 'magicPotion', now: true };

function view(overrides: Partial<InventoryProps> = {}) {
  const onUse = vi.fn();
  const onSend = vi.fn();
  const onBeltChange = vi.fn();
  const result = render(
    <Inventory
      inventory={inventory}
      onUse={onUse}
      onSend={onSend}
      belt={belt(deploy, compact)}
      onBeltChange={onBeltChange}
      {...overrides}
    />,
  );
  return { ...result, onUse, onSend, onBeltChange };
}

const tile = (name: RegExp) => screen.getByRole('button', { name });
const list = (name: string) => screen.getByRole('region', { name });

describe('Inventory tiles', () => {
  afterEach(() => cleanup());

  it('shows all six categories in order, each with its count', () => {
    view();
    const tiles = within(screen.getByRole('group', { name: 'Categories' })).getAllByRole('button');
    expect(tiles.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Spells (skills): 2',
      'Items (slash commands): 2',
      'Equipment (MCP servers): 3',
      'Relics (plugins): 1',
      'Guild (agents): 1',
      'Abilities (hooks): 1',
    ]);
  });

  it('marks each tile with its themed icon', () => {
    const { container } = view();
    for (const name of ['spells', 'items', 'equipment', 'relics', 'guild', 'abilities']) {
      expect(container.querySelector(`[data-tile='${name}'] svg`)?.classList.contains(`cb-icon-${name}`)).toBe(true);
    }
  });

  it('explains each tile in a themed tooltip, not the browser title', () => {
    const { container } = view();
    expect(container.querySelector('[data-tile][title]')).toBeNull();
    const tips = screen.getAllByRole('tooltip', { hidden: true }).map((tip) => tip.textContent);
    expect(tips).toContain('Relics (plugins)');
  });

  it('opens on Spells, and a tile swaps the list below', () => {
    view();
    expect(within(list('Spells')).getByText('code-review')).toBeTruthy();
    fireEvent.click(tile(/^Guild/));
    expect(tile(/^Guild/).getAttribute('aria-pressed')).toBe('true');
    expect(tile(/^Spells/).getAttribute('aria-pressed')).toBe('false');
    expect(within(list('Guild')).getByText('code-reviewer')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Spells' })).toBeNull();
  });

  it('keeps an empty tile in place, dimmed, and says so', () => {
    view({ inventory: { ...emptyInventory(), spells: inventory.spells } });
    expect(tile(/^Guild/).getAttribute('data-empty')).toBe('true');
    fireEvent.click(tile(/^Guild/));
    expect(within(list('Guild')).getByText(/reports no Guild/)).toBeTruthy();
  });

  it('flags a tile when something in it has failed', () => {
    view();
    expect(tile(/^Equipment/).querySelector('[data-alert]')).not.toBeNull();
    expect(tile(/^Spells/).querySelector('[data-alert]')).toBeNull();
  });

  it('says what will appear before the engine reports anything', () => {
    view({ inventory: emptyInventory() });
    expect(screen.getByText(/appears once the Quest starts/)).toBeTruthy();
  });
});

describe('Inventory rows', () => {
  afterEach(() => cleanup());

  it('uses a Spell or Item by handing over its prompt text', () => {
    const { onUse } = view();
    fireEvent.click(within(list('Spells')).getByRole('button', { name: 'code-review' }));
    expect(onUse).toHaveBeenCalledWith('/code-review ');
    fireEvent.click(tile(/^Items/));
    fireEvent.click(within(list('Items')).getByRole('button', { name: 'compact' }));
    expect(onUse).toHaveBeenCalledWith('/compact ');
  });

  it('shows a plugin-s Spell by its short name, with the plugin under it', () => {
    view();
    const row = within(list('Spells')).getByText('deploy').closest('li')!;
    expect(within(row).getByText('forge')).toBeTruthy();
  });

  it('keeps a hook-s full name: its colon isn-t a plugin', () => {
    view();
    fireEvent.click(tile(/^Abilities/));
    expect(within(list('Abilities')).getByText('SessionStart:startup')).toBeTruthy();
  });

  it('shows whether each piece of Equipment works, and what it brings', () => {
    view();
    fireEvent.click(tile(/^Equipment/));
    const equipment = within(list('Equipment'));
    expect(equipment.getByText('flaky').closest('li')!.getAttribute('data-status')).toBe('failed');
    expect(equipment.getByText('sentry').closest('li')!.getAttribute('data-status')).toBe('needs-auth');
    expect(equipment.getByText('2 tools · user')).toBeTruthy();
  });

  it('notes that account connectors arrive after the first turn until one is listed', () => {
    view();
    fireEvent.click(tile(/^Equipment/));
    expect(screen.getByText(/connectors.*after the first turn/i)).toBeTruthy();
    cleanup();
    view({
      inventory: {
        ...inventory,
        equipment: [{ category: 'equipment', name: 'claude.ai Gmail', use: 'x', status: 'ok' }],
      },
    });
    fireEvent.click(tile(/^Equipment/));
    expect(screen.queryByText(/connectors.*after the first turn/i)).toBeNull();
  });

  it('shows what a Relic brings, with nothing to use', () => {
    view();
    fireEvent.click(tile(/^Relics/));
    const relics = list('Relics');
    expect(within(relics).getByText('plugin 2.1.0 · Spells 1')).toBeTruthy();
    expect(within(relics).queryAllByRole('button')).toHaveLength(0);
  });

  it('leaves Abilities read-only', () => {
    view();
    fireEvent.click(tile(/^Abilities/));
    expect(within(list('Abilities')).queryAllByRole('button')).toHaveLength(0);
  });

  it('draws a Guild agent as its Hero when the art is loaded, and its category icon otherwise', () => {
    const withArt = view({ manifest });
    fireEvent.click(tile(/^Guild/));
    expect(withArt.container.querySelector(`[data-row='code-reviewer'] .cb-icon-guild`)).toBeNull();
    expect(withArt.container.querySelector(`[data-row='code-reviewer'] canvas`)).not.toBeNull();
    cleanup();
    const plain = view();
    fireEvent.click(tile(/^Guild/));
    expect(plain.container.querySelector(`[data-row='code-reviewer'] .cb-icon-guild`)).not.toBeNull();
  });
});

describe('Inventory search', () => {
  afterEach(() => cleanup());

  it('filters across every tile, updating their counts', () => {
    view();
    fireEvent.change(screen.getByRole('searchbox', { name: /Search/ }), { target: { value: 'review' } });
    expect(tile(/^Spells/).getAttribute('aria-label')).toBe('Spells (skills): 1');
    expect(tile(/^Items/).getAttribute('aria-label')).toBe('Items (slash commands): 0');
    expect(within(list('Spells')).queryByText('deploy')).toBeNull();
  });

  it('moves to the first tile with a match when the selected one has none', () => {
    view();
    fireEvent.change(screen.getByRole('searchbox', { name: /Search/ }), { target: { value: 'cle' } });
    expect(within(list('Items')).getByRole('button', { name: 'clear' })).toBeTruthy();
    expect(within(list('Items')).queryByRole('button', { name: 'compact' })).toBeNull();
  });
});

describe('the Belt', () => {
  afterEach(() => cleanup());
  const slot = (name: RegExp) => within(screen.getByRole('group', { name: 'Belt' })).getByRole('button', { name });

  it('has eight slots', () => {
    view();
    expect(within(screen.getByRole('group', { name: 'Belt' })).getAllByRole('button')).toHaveLength(BELT_SIZE);
  });

  it('fills the prompt on a click, without sending', () => {
    const { onUse, onSend } = view();
    fireEvent.click(slot(/^deploy/));
    expect(onUse).toHaveBeenCalledWith('/deploy ');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('sends at once from a slot set to, marked with the lightning', () => {
    const { onUse, onSend } = view();
    expect(slot(/^compact/).querySelector('.cb-icon-instant')).not.toBeNull();
    expect(slot(/^deploy/).querySelector('.cb-icon-instant')).toBeNull();
    fireEvent.click(slot(/^compact/));
    expect(onSend).toHaveBeenCalledWith('/compact');
    expect(onUse).not.toHaveBeenCalled();
  });

  it('fills the prompt instead when there-s nowhere to send, as on a closed Quest', () => {
    const { onUse } = view({ onSend: undefined });
    fireEvent.click(slot(/^compact/));
    expect(onUse).toHaveBeenCalledWith('/compact ');
  });

  it('fires slots with Alt and a number, by the key-s position', () => {
    const { onUse, onSend } = view();
    fireEvent.keyDown(window, { altKey: true, code: 'Digit1', key: '¡' });
    expect(onUse).toHaveBeenCalledWith('/deploy ');
    fireEvent.keyDown(window, { altKey: true, code: 'Digit2', key: '™' });
    expect(onSend).toHaveBeenCalledWith('/compact');
    onUse.mockClear();
    fireEvent.keyDown(window, { altKey: true, code: 'Digit9' });
    fireEvent.keyDown(window, { code: 'Digit1' });
    fireEvent.keyDown(window, { altKey: true, code: 'Digit3' });
    expect(onUse).not.toHaveBeenCalled();
  });

  it('dims a slot whose source isn-t in this Quest, and it still works', () => {
    const gone: BeltSlot = { ...deploy, source: { category: 'spells', name: 'gone' } };
    const { onUse } = view({ belt: belt(gone) });
    expect(slot(/^deploy/).getAttribute('data-missing')).toBe('true');
    fireEvent.click(slot(/^deploy/));
    expect(onUse).toHaveBeenCalledWith('/deploy ');
  });

  it('draws an agent-s slot as its Hero', () => {
    const agent: BeltSlot = {
      label: 'code-reviewer',
      text: 'Use the code-reviewer agent to ',
      source: { category: 'guild', name: 'code-reviewer' },
    };
    view({ belt: belt(agent), manifest });
    expect(slot(/^code-reviewer/).querySelector('.cb-icon')).toBeNull();
    cleanup();
    view({ belt: belt(agent) });
    expect(slot(/^code-reviewer/).querySelector('.cb-icon-guild')).not.toBeNull();
  });

  it('adds a row with its button, and takes it off again', () => {
    const { onBeltChange } = view();
    fireEvent.click(within(list('Spells')).getByRole('button', { name: 'Add code-review to Belt' }));
    expect(onBeltChange.mock.calls[0]![0][2]).toMatchObject({ label: 'code-review', text: '/code-review ' });
    cleanup();
    const onIt = view({ belt: belt({ label: 'code-review', text: '/code-review ' }) });
    fireEvent.click(within(list('Spells')).getByRole('button', { name: 'Take code-review off Belt' }));
    expect(onIt.onBeltChange.mock.calls[0]![0][0]).toBeNull();
  });

  it('says so when the Belt is full', () => {
    const full = Array.from({ length: BELT_SIZE }, (_, i) => ({ label: `s${i}`, text: `s${i}`, icon: 'rocket' }));
    const { onBeltChange } = view({ belt: full });
    fireEvent.click(within(list('Spells')).getByRole('button', { name: 'Add code-review to Belt' }));
    expect(onBeltChange).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toMatch(/full/i);
  });

  it('adds a dragged row to the slot it lands on', () => {
    const { onBeltChange } = view();
    const row = within(list('Spells')).getByText('code-review').closest('li')!;
    fireEvent.dragStart(row);
    fireEvent.drop(slot(/^Empty slot 5/));
    expect(onBeltChange.mock.calls[0]![0][4]).toMatchObject({ label: 'code-review' });
  });

  it('swaps a dragged slot with the one it lands on', () => {
    const { onBeltChange } = view();
    fireEvent.dragStart(slot(/^deploy/));
    fireEvent.drop(slot(/^compact/));
    expect(onBeltChange.mock.calls[0]![0].slice(0, 2)).toEqual([compact, deploy]);
  });

  it('adds nothing for a row that can-t be used', () => {
    view();
    fireEvent.click(tile(/^Abilities/));
    const row = within(list('Abilities')).getByText('SessionStart:startup').closest('li')!;
    expect(row.getAttribute('draggable')).not.toBe('true');
  });
});

describe('editing a slot', () => {
  afterEach(() => cleanup());
  const slot = (name: RegExp) => within(screen.getByRole('group', { name: 'Belt' })).getByRole('button', { name });
  const edit = () => fireEvent.click(screen.getByRole('button', { name: 'Edit slots' }));

  it('swaps the list for the slot-s editor, and picking no longer fires it', () => {
    const { onUse } = view();
    edit();
    fireEvent.click(slot(/^deploy/));
    expect(onUse).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Spells' })).toBeNull();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('deploy');
  });

  it('opens the editor on an empty slot without edit mode', () => {
    view();
    fireEvent.click(slot(/^Empty slot 3/));
    expect((screen.getByLabelText('Prompt text') as HTMLTextAreaElement).value).toBe('');
  });

  it('saves its changes together on Done', () => {
    const { onBeltChange } = view();
    edit();
    fireEvent.click(slot(/^deploy/));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ship it' } });
    expect(onBeltChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Prompt text'), { target: { value: 'Ship it now.' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Send at once' }));
    fireEvent.click(screen.getByRole('button', { name: 'sail' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onBeltChange.mock.calls[0]![0][0]).toEqual({
      label: 'Ship it',
      text: 'Ship it now.',
      icon: 'sail',
      now: true,
    });
    expect(screen.getByRole('region', { name: 'Spells' })).toBeTruthy();
  });

  it('turns typed text into a slot, named from its words', () => {
    const { onBeltChange } = view();
    fireEvent.click(slot(/^Empty slot 3/));
    fireEvent.change(screen.getByLabelText('Prompt text'), { target: { value: 'Run the tests' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onBeltChange.mock.calls[0]![0][2]).toMatchObject({
      label: 'Run the tests',
      text: 'Run the tests',
      icon: 'bubblingFlask',
    });
  });

  it('leaves a slot empty when it has no text', () => {
    const { onBeltChange } = view();
    fireEvent.click(slot(/^Empty slot 3/));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onBeltChange).not.toHaveBeenCalled();
  });

  it('empties a slot', () => {
    const { onBeltChange } = view();
    edit();
    fireEvent.click(slot(/^compact/));
    fireEvent.click(screen.getByRole('button', { name: 'Empty slot' }));
    expect(onBeltChange.mock.calls[0]![0][1]).toBeNull();
  });
});
