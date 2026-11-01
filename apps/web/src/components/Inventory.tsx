import { useEffect, useRef, useState } from 'react';
import {
  isOnBelt,
  placeOnBelt,
  slotFromEntry,
  splitName,
  swapSlots,
  takeOffBelt,
  type Belt,
  type BeltSlot,
} from '../belt.js';
import type { HeroManifest } from '../heroes.js';
import {
  CATEGORIES,
  filterInventory,
  grantsOf,
  type Inventory as InventoryData,
  type InventoryCategory,
  type InventoryEntry,
} from '../inventory.js';
import { iconForName } from '../theme/armory.js';
import { Icon } from '../theme/icons.js';
import { hint, w } from '../theme/words.js';
import { AgentGlyph, ArmoryIcon, BeltHeader, BeltSlots, SlotEditor } from './Belt.js';
import { Tip } from './Tip.js';

export interface InventoryProps {
  inventory: InventoryData;
  /** Puts an entry's prompt text into the follow-up box, without sending. */
  onUse: (text: string) => void;
  /** Sends text as a follow-up, for a slot set to send at once; absent when nothing can be sent, as on a closed Quest. */
  onSend?: (text: string) => void;
  belt: Belt;
  onBeltChange: (belt: Belt) => void;
  /** The art pack, which draws agents as their Heroes; absent in the Classic theme. */
  manifest?: HeroManifest;
}

const STATUS_DOT: Record<NonNullable<InventoryEntry['status']>, string> = {
  ok: 'bg-green-500',
  failed: 'bg-red-500',
  pending: 'bg-amber-400',
  'needs-auth': 'bg-amber-400',
  unknown: 'bg-neutral-400',
};

/** Where a tile's tooltip lines up, so the panel's edge doesn't clip it. */
const TILE_ALIGN = ['start', 'center', 'end'] as const;

function Tile({
  category,
  index,
  count,
  selected,
  alert,
  onPick,
}: {
  category: InventoryCategory;
  index: number;
  count: number;
  selected: boolean;
  alert: boolean;
  onPick: () => void;
}) {
  return (
    <Tip text={hint(category)} align={TILE_ALIGN[index % 3]} className="block">
      <button
        type="button"
        aria-label={`${hint(category)}: ${count}`}
        aria-pressed={selected}
        onClick={onPick}
        data-tile={category}
        data-empty={count === 0}
        className="cb-socket cb-tile"
      >
        <Icon name={category} size={44} />
        <span className="cb-tile-count">{count}</span>
        {alert && <span data-alert className="cb-tile-alert" />}
      </button>
    </Tip>
  );
}

/** What a row says under its name. */
function rowNote(entry: InventoryEntry, plugin: string | undefined, inventory: InventoryData): string | undefined {
  if (entry.category !== 'gear') return entry.detail ?? plugin;
  const { spells, items } = grantsOf(inventory, entry.name);
  const grants = [
    ...(spells > 0 ? [`${w('spells')} ${spells}`] : []),
    ...(items > 0 ? [`${w('items')} ${items}`] : []),
  ];
  return [entry.detail, grants.join(', ')].filter(Boolean).join(' · ');
}

function RowGlyph({
  entry,
  short,
  category,
  manifest,
}: {
  entry: InventoryEntry;
  short: string;
  category: InventoryCategory;
  manifest?: HeroManifest;
}) {
  if (entry.status) {
    return (
      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center" title={entry.status}>
        <span className={`h-2 w-2 rounded-full ${STATUS_DOT[entry.status]}`} />
      </span>
    );
  }
  if (category === 'guild') return <AgentGlyph name={entry.name} manifest={manifest} size={22} />;
  return <ArmoryIcon icon={iconForName(short) ?? category} fallback={category} size={20} />;
}

function Row({
  entry,
  category,
  inventory,
  manifest,
  onBelt,
  onUse,
  onToggleBelt,
  onDragStart,
}: {
  entry: InventoryEntry;
  category: InventoryCategory;
  inventory: InventoryData;
  manifest?: HeroManifest;
  onBelt: boolean;
  onUse: (text: string) => void;
  onToggleBelt: (entry: InventoryEntry) => void;
  onDragStart: (entry: InventoryEntry) => void;
}) {
  // A hook's name has a colon too (`SessionStart:startup`), but only these come from plugins.
  const prefixed = category === 'spells' || category === 'items' || category === 'guild';
  const { short, plugin } = prefixed ? splitName(entry.name) : { short: entry.name, plugin: undefined };
  const note = rowNote(entry, plugin, inventory);
  const body = (
    <>
      <span className="block truncate font-mono text-xs">{short}</span>
      {note && <span className="block truncate text-xs text-neutral-500">{note}</span>}
    </>
  );
  return (
    <li
      data-row={entry.name}
      data-status={entry.status}
      draggable={entry.use !== undefined}
      onDragStart={(event) => {
        event.dataTransfer?.setData('text/plain', entry.name);
        onDragStart(entry);
      }}
      className="group flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-neutral-200 dark:hover:bg-neutral-800"
    >
      <RowGlyph entry={entry} short={short} category={category} manifest={manifest} />
      {entry.use ? (
        <button type="button" onClick={() => onUse(entry.use!)} className="min-w-0 flex-1 text-left">
          {body}
        </button>
      ) : (
        <div className="min-w-0 flex-1">{body}</div>
      )}
      {entry.use && (
        <button
          type="button"
          aria-label={onBelt ? `Take ${entry.name} off ${w('belt')}` : `Add ${entry.name} to ${w('belt')}`}
          aria-pressed={onBelt}
          onClick={() => onToggleBelt(entry)}
          className="cb-belt-toggle"
        >
          <Icon name="belt" size={14} />
        </button>
      )}
    </li>
  );
}

/**
 * The Quest's Inventory (docs/THEME.md): the Belt of quick actions, a tile for each category, and the picked
 * category's list below them. Entries come from pluggable sources in `inventory.ts`.
 */
export function Inventory({ inventory, onUse, onSend, belt, onBeltChange, manifest }: InventoryProps) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<InventoryCategory>('spells');
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const dragged = useRef<{ entry: InventoryEntry } | { from: number } | null>(null);

  const shown = filterInventory(inventory, query);
  const empty = CATEGORIES.every((category) => inventory[category].length === 0);
  // A search follows the matches: the picked tile unless it has none.
  const category =
    query.trim() && shown[picked].length === 0
      ? (CATEGORIES.find((candidate) => shown[candidate].length > 0) ?? picked)
      : picked;

  function fire(slot: BeltSlot) {
    if (slot.now && onSend) onSend(slot.text.trim());
    else onUse(slot.text);
  }

  // Fires from a window listener, so it reads the current Belt through a ref.
  const fireIndex = useRef<(index: number) => void>(() => {});
  fireIndex.current = (index) => {
    const slot = belt[index];
    if (slot) fire(slot);
  };
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      // By position: on a Mac, Alt and a digit types a symbol.
      const digit = /^Digit([1-8])$/.exec(event.code);
      if (!digit || !event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      fireIndex.current(Number(digit[1]) - 1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function pickSlot(index: number) {
    const slot = belt[index];
    if (editing || !slot) {
      setEditing(true);
      setSelected(index);
    } else {
      fire(slot);
    }
  }

  function closeEditor() {
    setEditing(false);
    setSelected(null);
  }

  function addToBelt(entry: InventoryEntry, at?: number) {
    const next = placeOnBelt(belt, slotFromEntry(entry), at);
    if (next) {
      setNote(null);
      onBeltChange(next);
    } else {
      setNote(`The ${w('belt')} is full. Drag this onto a slot to replace it.`);
    }
  }

  function toggleBelt(entry: InventoryEntry) {
    if (isOnBelt(belt, entry)) onBeltChange(takeOffBelt(belt, entry));
    else addToBelt(entry);
  }

  function drop(index: number) {
    const held = dragged.current;
    dragged.current = null;
    if (!held) return;
    if ('entry' in held) addToBelt(held.entry, index);
    else if (held.from !== index) onBeltChange(swapSlots(belt, held.from, index));
  }

  const connectorNote = category === 'runes' && !empty && !inventory.runes.some((e) => e.name.startsWith('claude.ai '));

  return (
    <div className="flex h-full min-h-[34rem] flex-col gap-2 text-sm">
      <BeltHeader
        filled={belt.filter(Boolean).length}
        editing={editing}
        onToggle={() => (editing ? closeEditor() : setEditing(true))}
      />
      <BeltSlots
        belt={belt}
        inventory={inventory}
        manifest={manifest}
        editing={editing}
        selected={selected}
        onPick={pickSlot}
        onDragStart={(from) => (dragged.current = { from })}
        onDrop={drop}
      />
      <div role="group" aria-label="Categories" className="mt-1 grid grid-cols-3 gap-2">
        {CATEGORIES.map((candidate, index) => (
          <Tile
            key={candidate}
            category={candidate}
            index={index}
            count={shown[candidate].length}
            selected={candidate === category}
            alert={inventory[candidate].some((entry) => entry.status === 'failed')}
            onPick={() => {
              setPicked(candidate);
              closeEditor();
            }}
          />
        ))}
      </div>
      {selected !== null ? (
        <section
          aria-label={`Slot ${selected + 1}`}
          className="flex min-h-0 flex-1 flex-col gap-2 border-t border-neutral-300 pt-2 dark:border-neutral-700"
        >
          <h3 className="cb-display text-lg leading-none">Slot {selected + 1}</h3>
          <SlotEditor
            key={selected}
            slot={belt[selected] ?? null}
            onDone={(slot) => {
              if (slot || belt[selected]) onBeltChange(belt.map((current, i) => (i === selected ? slot : current)));
              closeEditor();
            }}
            onEmpty={() => {
              onBeltChange(belt.map((current, i) => (i === selected ? null : current)));
              closeEditor();
            }}
          />
        </section>
      ) : (
        <section
          aria-label={w(category)}
          className="flex min-h-0 flex-1 flex-col gap-1.5 border-t border-neutral-300 pt-2 dark:border-neutral-700"
        >
          <h3 className="cb-display flex items-center gap-1.5 text-lg leading-none">
            <Icon name={category} size={18} />
            {w(category)}
            <span className="ml-auto font-sans text-xs text-neutral-500">{shown[category].length}</span>
          </h3>
          <input
            type="search"
            aria-label={`Search ${w('inventory')}`}
            placeholder={`Search ${w('inventory')}`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="cb-field w-full text-xs"
          />
          {note && (
            <p role="status" className="text-xs text-neutral-500">
              {note}
            </p>
          )}
          {shown[category].length > 0 ? (
            <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
              {shown[category].map((entry) => (
                <Row
                  key={`${entry.category}:${entry.name}`}
                  entry={entry}
                  category={category}
                  inventory={inventory}
                  manifest={manifest}
                  onBelt={isOnBelt(belt, entry)}
                  onUse={onUse}
                  onToggleBelt={toggleBelt}
                  onDragStart={(held) => (dragged.current = { entry: held })}
                />
              ))}
            </ul>
          ) : (
            <p className="px-1 text-xs text-neutral-500">
              {empty
                ? `The ${w('inventory')} appears once the ${w('quest')} starts.`
                : query.trim()
                  ? `No ${w(category)} match.`
                  : `This ${w('quest')} reports no ${w(category)}.`}
            </p>
          )}
          {connectorNote && (
            // The CLI fetches account connectors in the background; a headless session lists them from its second turn.
            <p className="px-1 text-xs text-neutral-500">
              Account connectors, if you have any, arrive after the first turn.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
