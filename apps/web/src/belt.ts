import type { Appearance, BeltSlot } from '@crystal-bridge/protocol';
import type { Inventory, InventoryEntry } from './inventory.js';
import { iconForName } from './theme/armory.js';

/**
 * The Belt (docs/THEME.md): a Kingdom's quick actions. A slot is prompt text with a look, so it works on any engine
 * and any harness. Belts sync through the appearance, like a Kingdom's look.
 */
export type { BeltSlot };
export type Belt = (BeltSlot | null)[];

export const BELT_SIZE = 8;

/** A Kingdom's Belt until the user changes it. Plain prompts, so they need no plugin, skill or hook. */
const STARTER: readonly BeltSlot[] = [
  { label: 'Continue', text: 'Continue.', icon: 'compass' },
  { label: 'Run the tests', text: 'Run the tests and fix what fails.', icon: 'bubblingFlask' },
  { label: 'Review the diff', text: 'Review the diff.', icon: 'magnifyingGlass' },
];

function fit(slots: readonly (BeltSlot | null)[]): Belt {
  return Array.from({ length: BELT_SIZE }, (_, index) => slots[index] ?? null);
}

export function beltFor(appearance: Appearance, kingdom: string): Belt {
  return fit(appearance.belts?.[kingdom] ?? STARTER);
}

export function withBelt(appearance: Appearance, kingdom: string, belt: Belt): Appearance {
  return { ...appearance, belts: { ...appearance.belts, [kingdom]: belt } };
}

/** `plugin:skill` as the two parts worth showing: the name, and the plugin it's from. */
export function splitName(name: string): { short: string; plugin?: string } {
  const at = name.lastIndexOf(':');
  return at < 0 ? { short: name } : { short: name.slice(at + 1), plugin: name.slice(0, at) };
}

/** A slot for an Inventory entry. An agent gets no icon, because its Hero stands in. */
export function slotFromEntry(entry: InventoryEntry): BeltSlot {
  const { short } = splitName(entry.name);
  const source = { category: entry.category, name: entry.name };
  const base = { label: short, text: entry.use ?? '', source };
  return entry.category === 'guild' ? base : { ...base, icon: iconForName(short) ?? entry.category };
}

/** The Belt with `slot` at `at`, or in the first empty slot; undefined when there's no room. */
export function placeOnBelt(belt: Belt, slot: BeltSlot, at?: number): Belt | undefined {
  const index = at ?? belt.indexOf(null);
  if (index < 0) return undefined;
  return belt.map((current, i) => (i === index ? slot : current));
}

export function swapSlots(belt: Belt, a: number, b: number): Belt {
  return belt.map((slot, i) => (i === a ? belt[b]! : i === b ? belt[a]! : slot));
}

export function isOnBelt(belt: Belt, entry: InventoryEntry): boolean {
  return belt.some((slot) => slot?.text === entry.use);
}

export function takeOffBelt(belt: Belt, entry: InventoryEntry): Belt {
  return belt.map((slot) => (slot?.text === entry.use ? null : slot));
}

/**
 * Whether a slot's source is absent from this Quest, which dims it. A category with nothing in it may simply not be
 * reported (an interactive Quest lists no Items), so that says nothing about the slot.
 */
export function slotMissing(slot: BeltSlot, inventory: Inventory): boolean {
  if (!slot.source) return false;
  const entries = inventory[slot.source.category as keyof Inventory] ?? [];
  return entries.length > 0 && !entries.some((entry) => entry.name === slot.source!.name);
}
