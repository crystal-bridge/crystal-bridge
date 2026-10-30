import { describe, expect, it } from 'vitest';
import {
  BELT_SIZE,
  beltFor,
  isOnBelt,
  placeOnBelt,
  slotFromEntry,
  slotMissing,
  swapSlots,
  takeOffBelt,
  withBelt,
  type Belt,
} from './belt.js';
import { emptyInventory, type Inventory, type InventoryEntry } from './inventory.js';

const spell: InventoryEntry = { category: 'spells', name: 'forge:deploy', use: '/forge:deploy ' };

function belt(...slots: Belt): Belt {
  return [...slots, ...Array<null>(BELT_SIZE - slots.length).fill(null)];
}

describe('beltFor', () => {
  it('starts a Kingdom with plain prompts, which need no plugin, skill or hook', () => {
    const slots = beltFor({}, 'k');
    expect(slots).toHaveLength(BELT_SIZE);
    const filled = slots.filter((slot) => slot !== null);
    expect(filled.map((slot) => slot.label)).toEqual(['Continue', 'Run the tests', 'Review the diff']);
    expect(filled.every((slot) => !slot.text.startsWith('/') && !slot.source && !slot.now)).toBe(true);
  });

  it('keeps each Kingdom-s own Belt, and an emptied one stays empty', () => {
    const emptied = withBelt({}, 'a', belt());
    expect(beltFor(emptied, 'a').every((slot) => slot === null)).toBe(true);
    expect(beltFor(emptied, 'b').some((slot) => slot !== null)).toBe(true);
  });

  it('pads a short saved Belt and cuts a long one to eight slots', () => {
    const slot = { label: 'x', text: 'x' };
    const short = withBelt({}, 'k', [slot]);
    expect(beltFor(short, 'k')).toEqual(belt(slot));
    const long = withBelt({}, 'k', Array<typeof slot>(10).fill(slot));
    expect(beltFor(long, 'k')).toHaveLength(BELT_SIZE);
  });
});

describe('withBelt', () => {
  it('leaves the rest of the appearance alone', () => {
    const next = withBelt({ tabStyle: 'tinted', belts: { other: [] } }, 'k', belt());
    expect(next.tabStyle).toBe('tinted');
    expect(next.belts?.other).toEqual([]);
  });
});

describe('slotFromEntry', () => {
  it('takes a short label and a default icon, and remembers where it came from', () => {
    expect(slotFromEntry(spell)).toEqual({
      label: 'deploy',
      text: '/forge:deploy ',
      icon: 'rocket',
      source: { category: 'spells', name: 'forge:deploy' },
    });
  });

  it('falls back to the category-s icon', () => {
    expect(slotFromEntry({ category: 'spells', name: 'zzz', use: '/zzz ' }).icon).toBe('spells');
  });

  it('leaves an agent-s icon open, because its Hero stands in', () => {
    const slot = slotFromEntry({ category: 'guild', name: 'code-reviewer', use: 'Use the code-reviewer agent to ' });
    expect(slot.icon).toBeUndefined();
  });
});

describe('placeOnBelt', () => {
  const slot = { label: 'x', text: 'x' };

  it('takes the first empty slot, or the one asked for', () => {
    const first = { label: 'a', text: 'a' };
    expect(placeOnBelt(belt(first), slot)).toEqual(belt(first, slot));
    expect(placeOnBelt(belt(first), slot, 0)).toEqual(belt(slot));
  });

  it('returns nothing when the Belt is full', () => {
    expect(placeOnBelt(Array<typeof slot>(BELT_SIZE).fill(slot), slot)).toBeUndefined();
  });
});

describe('moving slots', () => {
  const a = { label: 'a', text: 'a' };
  const b = { label: 'b', text: 'b' };

  it('swaps two slots, an empty one too', () => {
    expect(swapSlots(belt(a, b), 0, 1)).toEqual(belt(b, a));
    expect(swapSlots(belt(a), 0, 3).slice(0, 4)).toEqual([null, null, null, a]);
  });

  it('knows what-s on the Belt by its prompt text, and can take it off', () => {
    const entry: InventoryEntry = { category: 'spells', name: 'a', use: 'a' };
    expect(isOnBelt(belt(a), entry)).toBe(true);
    expect(isOnBelt(belt(b), entry)).toBe(false);
    expect(takeOffBelt(belt(a, b), entry)).toEqual(belt(null, b));
  });
});

describe('slotMissing', () => {
  const inventory: Inventory = {
    ...emptyInventory(),
    spells: [{ category: 'spells', name: 'here', use: '/here ' }],
  };

  it('flags a slot whose source isn-t in this Quest', () => {
    expect(slotMissing({ label: 'a', text: '/a ', source: { category: 'spells', name: 'gone' } }, inventory)).toBe(
      true,
    );
    expect(slotMissing({ label: 'a', text: '/a ', source: { category: 'spells', name: 'here' } }, inventory)).toBe(
      false,
    );
  });

  it('never flags a typed prompt', () => {
    expect(slotMissing({ label: 'a', text: 'hello' }, inventory)).toBe(false);
  });

  it('trusts a slot when its category reports nothing, as Items on an interactive Quest', () => {
    expect(slotMissing({ label: 'a', text: '/a', source: { category: 'items', name: 'compact' } }, inventory)).toBe(
      false,
    );
  });
});
