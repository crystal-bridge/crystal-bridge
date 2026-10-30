import { useState } from 'react';
import { filterInventory, type Inventory as InventoryData, type InventoryEntry } from '../inventory.js';
import { Icon } from '../theme/icons.js';
import { hint, w } from '../theme/words.js';
import { Tip } from './Tip.js';

export interface InventoryProps {
  inventory: InventoryData;
  /** Puts an entry's prompt text into the follow-up box, without sending. */
  onUse: (text: string) => void;
}

const STATUS_DOT: Record<NonNullable<InventoryEntry['status']>, string> = {
  ok: 'bg-green-500',
  failed: 'bg-red-500',
  pending: 'bg-amber-400',
  unknown: 'bg-neutral-400',
};

function Entries({ entries, onUse }: { entries: InventoryEntry[]; onUse: (text: string) => void }) {
  return (
    <ul className="space-y-0.5">
      {entries.map((entry) => (
        <li key={`${entry.category}:${entry.name}`} data-status={entry.status}>
          {entry.use ? (
            <button
              type="button"
              onClick={() => onUse(entry.use!)}
              title={entry.detail ?? `Put /${entry.name} in the prompt`}
              className="w-full truncate rounded px-2 py-1 text-left font-mono text-xs hover:bg-neutral-200 dark:hover:bg-neutral-800"
            >
              {entry.name}
            </button>
          ) : (
            <div className="flex items-center gap-2 px-2 py-1 text-xs" title={entry.detail}>
              {entry.status && (
                <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[entry.status]}`} title={entry.status} />
              )}
              <span className="truncate font-mono">{entry.name}</span>
              {entry.detail && <span className="ml-auto shrink-0 truncate text-neutral-500">{entry.detail}</span>}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function Section({
  concept,
  entries,
  onUse,
}: {
  concept: 'spells' | 'items' | 'equipment';
  entries: InventoryEntry[];
  onUse: (text: string) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <section aria-label={w(concept)} className="space-y-1">
      <h3 className="cb-display flex items-center gap-1.5 px-2 text-lg leading-none">
        <Tip text={hint(concept)} align="start">
          <span className="inline-flex items-center gap-1.5">
            <span data-icon={concept}>
              <Icon name={concept} />
            </span>
            {w(concept)}
          </span>
        </Tip>
        <span className="font-sans text-xs text-neutral-500">{entries.length}</span>
      </h3>
      <Entries entries={entries} onUse={onUse} />
    </section>
  );
}

/**
 * The Quest's Inventory (docs/THEME.md): Spells and Items to use, Equipment that's on, and Abilities that fire by
 * themselves (folded away: you rarely need them). Entries come from pluggable sources in `inventory.ts`.
 */
export function Inventory({ inventory, onUse }: InventoryProps) {
  const [query, setQuery] = useState('');
  const shown = filterInventory(inventory, query);
  const empty = Object.values(inventory).every((entries) => entries.length === 0);
  return (
    <div className="space-y-4 text-sm">
      <input
        type="search"
        aria-label={`Search ${w('inventory')}`}
        placeholder={`Search ${w('inventory')}`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-950"
      />
      {empty && (
        <p className="px-2 text-xs text-neutral-500">{`The ${w('inventory')} appears once the ${w('quest')} starts.`}</p>
      )}
      <Section concept="spells" entries={shown.spells} onUse={onUse} />
      <Section concept="items" entries={shown.items} onUse={onUse} />
      <Section concept="equipment" entries={shown.equipment} onUse={onUse} />
      {!empty && !inventory.equipment.some((entry) => entry.name.startsWith('claude.ai ')) && (
        // The CLI fetches account connectors in the background; a headless session lists them from its second turn.
        <p className="-mt-3 px-2 text-xs text-neutral-500">
          Account connectors, if you have any, arrive after the first turn.
        </p>
      )}
      {shown.abilities.length > 0 && (
        <details>
          <summary className="cb-display cursor-pointer px-2 text-lg leading-none">
            <Tip text={hint('abilities')} align="start">
              <span className="inline-flex items-center gap-1.5">
                <span data-icon="abilities">
                  <Icon name="abilities" />
                </span>
                {w('abilities')}
              </span>
            </Tip>{' '}
            <span className="font-sans text-xs text-neutral-500">{shown.abilities.length}</span>
          </summary>
          <div className="mt-1">
            <Entries entries={shown.abilities} onUse={onUse} />
          </div>
        </details>
      )}
    </div>
  );
}
