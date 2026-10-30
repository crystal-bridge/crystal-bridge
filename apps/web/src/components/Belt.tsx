import { useState } from 'react';
import { BELT_SIZE, slotMissing, type Belt, type BeltSlot } from '../belt.js';
import { matchClass, type HeroManifest } from '../heroes.js';
import type { Inventory } from '../inventory.js';
import { ARMORY, familyOf, iconForName } from '../theme/armory.js';
import { ICON_DATA } from '../theme/iconData.js';
import { Icon, type IconName } from '../theme/icons.js';
import { ICON_SOURCES } from '../theme/iconSources.js';
import { hint, w } from '../theme/words.js';
import { HeroSprite } from './HeroSprite.js';
import { Tip } from './Tip.js';

/** Where a slot's tooltip lines up, so the panel's edge doesn't clip it. */
const SLOT_ALIGN = ['start', 'center', 'center', 'end'] as const;

/** An icon in its family's colour; an id this build doesn't know (a fork removed it) draws the fallback. */
export function ArmoryIcon({ icon, fallback, size }: { icon: string; fallback: IconName; size?: number }) {
  const family = familyOf(icon);
  const name = icon in ICON_DATA ? (icon as IconName) : fallback;
  return (
    <span className={`inline-flex shrink-0 ${family ? `cb-family-${family}` : ''}`}>
      <Icon name={name} size={size} />
    </span>
  );
}

/** An agent's Hero when the art is loaded, else the Guild's icon (the Classic theme draws no Heroes). */
export function AgentGlyph({ name, manifest, size }: { name: string; manifest?: HeroManifest; size: number }) {
  if (!manifest) return <Icon name="guild" size={size} />;
  return <HeroSprite manifest={manifest} classId={matchClass(manifest, name)} state="resting" size={size} decorative />;
}

function SlotGlyph({ slot, manifest }: { slot: BeltSlot; manifest?: HeroManifest }) {
  if (slot.icon) return <ArmoryIcon icon={slot.icon} fallback="bullseye" size={32} />;
  if (slot.source?.category === 'guild') {
    return <AgentGlyph name={slot.source.name} manifest={manifest} size={36} />;
  }
  return <Icon name="bullseye" size={32} />;
}

function slotLabel(slot: BeltSlot | null, index: number, missing: boolean): string {
  if (!slot) return `Empty slot ${index + 1}`;
  return `${slot.label}${missing ? `, not in this ${w('quest')}` : ''}${slot.now ? ', sends at once' : ''}`;
}

export interface BeltSlotsProps {
  belt: Belt;
  inventory: Inventory;
  manifest?: HeroManifest;
  editing: boolean;
  selected: number | null;
  onPick: (index: number) => void;
  onDragStart: (index: number) => void;
  onDrop: (index: number) => void;
}

/** The Belt's slots, 4×2. What a pick means (fire it or edit it) is the panel's call. */
export function BeltSlots({
  belt,
  inventory,
  manifest,
  editing,
  selected,
  onPick,
  onDragStart,
  onDrop,
}: BeltSlotsProps) {
  const [over, setOver] = useState<number | null>(null);
  return (
    <div role="group" aria-label={w('belt')} className="grid grid-cols-4 gap-2">
      {belt.slice(0, BELT_SIZE).map((slot, index) => {
        const missing = slot !== null && slotMissing(slot, inventory);
        const label = slotLabel(slot, index, missing);
        return (
          <Tip key={index} text={label} align={SLOT_ALIGN[index % 4]} className="block">
            <button
              type="button"
              aria-label={label}
              onClick={() => onPick(index)}
              draggable={slot !== null}
              onDragStart={(event) => {
                // Firefox starts a drag only with data set.
                event.dataTransfer?.setData('text/plain', label);
                onDragStart(index);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setOver(index);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(event) => {
                event.preventDefault();
                setOver(null);
                onDrop(index);
              }}
              data-empty={slot === null}
              data-missing={missing}
              data-over={over === index}
              data-editing={editing}
              data-selected={selected === index}
              className="cb-socket cb-slot"
            >
              <span aria-hidden="true" className="cb-slot-key">
                {index + 1}
              </span>
              {slot ? (
                <span className="cb-slot-glyph">
                  <SlotGlyph slot={slot} manifest={manifest} />
                </span>
              ) : (
                <Icon name="attach" size={12} />
              )}
              {slot?.now && (
                <span className="cb-slot-now">
                  <Icon name="instant" size={12} />
                </span>
              )}
            </button>
          </Tip>
        );
      })}
    </div>
  );
}

export interface SlotEditorProps {
  slot: BeltSlot | null;
  /** The slot as edited, or null when it has no text left. */
  onDone: (slot: BeltSlot | null) => void;
  onEmpty: () => void;
}

/** Edits one slot in the list's place. Nothing is saved until Done, so typing doesn't reach the hub per keystroke. */
export function SlotEditor({ slot, onDone, onEmpty }: SlotEditorProps) {
  const [label, setLabel] = useState(slot?.label ?? '');
  const [text, setText] = useState(slot?.text ?? '');
  const [icon, setIcon] = useState(slot?.icon);
  const [now, setNow] = useState(slot?.now ?? false);

  function done() {
    if (!text.trim()) return onDone(null);
    // New text is the user's own prompt now, not the entry it came from.
    const source = text === slot?.text ? slot.source : undefined;
    const chosen = icon ?? (slot ? undefined : (iconForName(text) ?? 'bullseye'));
    onDone({
      label: label.trim() || text.trim().slice(0, 40),
      text,
      ...(chosen ? { icon: chosen } : {}),
      ...(now ? { now: true } : {}),
      ...(source ? { source } : {}),
    });
  }

  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
      <label className="block">
        <span className="text-xs text-neutral-500">Name</span>
        <input
          type="text"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          className="cb-field w-full text-sm"
        />
      </label>
      <label className="block">
        <span className="text-xs text-neutral-500">Prompt text</span>
        <textarea
          rows={2}
          value={text}
          onChange={(event) => setText(event.target.value)}
          className="cb-field w-full resize-none font-mono text-xs"
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={now} onChange={(event) => setNow(event.target.checked)} className="cb-check" />
        Send at once
      </label>
      <div role="group" aria-label="Icon" className="grid grid-cols-6 gap-0.5">
        {ARMORY.flatMap((family) => family.icons).map((name) => (
          <button
            key={name}
            type="button"
            aria-label={ICON_SOURCES[name].icon}
            aria-pressed={icon === name}
            onClick={() => setIcon(name)}
            className="cb-icon-choice"
          >
            <ArmoryIcon icon={name} fallback="bullseye" size={24} />
          </button>
        ))}
      </div>
      <div className="flex justify-between gap-2">
        <button type="button" onClick={onEmpty} className="cb-belt-action">
          Empty slot
        </button>
        <button type="button" onClick={done} className="cb-belt-action">
          Done
        </button>
      </div>
    </div>
  );
}

/** The Belt's title row, with the toggle for edit mode. */
export function BeltHeader({ filled, editing, onToggle }: { filled: number; editing: boolean; onToggle: () => void }) {
  return (
    <h3 className="cb-display flex items-center gap-1.5 text-lg leading-none">
      <Tip text={hint('belt')} align="start">
        <span className="inline-flex items-center gap-1.5">
          <Icon name="belt" size={18} />
          {w('belt')}
        </span>
      </Tip>
      <span className="ml-auto font-sans text-xs text-neutral-500">
        {filled}/{BELT_SIZE}
      </span>
      <Tip text="Edit slots" align="end">
        <button
          type="button"
          aria-label="Edit slots"
          aria-pressed={editing}
          onClick={onToggle}
          className="rounded p-0.5 hover:bg-neutral-200 dark:hover:bg-neutral-800"
        >
          <Icon name="edit" size={14} />
        </button>
      </Tip>
    </h3>
  );
}
