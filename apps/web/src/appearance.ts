import { Appearance } from '@crystal-bridge/protocol';
import { BANNER_COLOURS, KINGDOM_ICONS } from './theme/kingdomIcons.js';
import { DEFAULT_PROMPT_COLOUR, PROMPT_COLOURS, type PromptColour } from './theme/promptColours.js';

/**
 * How Kingdoms look: each one's icon and banner colour, and how tabs show the colour. Unlike names, hidden Kingdoms
 * and notification levels (per device, in kingdoms.ts), the appearance is the user's and syncs through the hub to
 * all their devices. A local copy draws it before the hub answers.
 */
export type { Appearance };

/** A Kingdom's look, resolved: an icon id and a banner colour. */
export interface KingdomLook {
  icon: string;
  colour: string;
  /** The Class leading this Kingdom's Quests, or `varied`; unset means the art pack's leader. */
  leader?: string;
}

export type TabStyle = 'underline' | 'tinted' | 'pennant';

export const TAB_STYLES: { value: TabStyle; label: string }[] = [
  { value: 'underline', label: 'Underline' },
  { value: 'tinted', label: 'Tinted' },
  { value: 'pennant', label: 'Pennant' },
];

/** A small stable hash, so a Kingdom with no chosen look gets the same one everywhere. */
function hash(id: string): number {
  let h = 2166136261;
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** A Kingdom's look: the user's choice per field, else one derived from the Kingdom id. */
export function lookFor(appearance: Appearance, id: string): KingdomLook {
  const h = hash(id);
  const chosen = appearance.looks?.[id];
  const icon = KINGDOM_ICONS.find((i) => i.id === chosen?.icon)?.id ?? KINGDOM_ICONS[h % KINGDOM_ICONS.length]!.id;
  const colour =
    BANNER_COLOURS.find((c) => c.hex === chosen?.colour)?.hex ??
    BANNER_COLOURS[Math.floor(h / KINGDOM_ICONS.length) % BANNER_COLOURS.length]!.hex;
  const leader = chosen?.leader;
  return leader ? { icon, colour, leader } : { icon, colour };
}

export function tabStyle(appearance: Appearance): TabStyle {
  return TAB_STYLES.find((s) => s.value === appearance.tabStyle)?.value ?? 'underline';
}

/** The chosen prompt colour, or the default for none or for one this client doesn't know. */
export function promptColourFor(appearance: Appearance): PromptColour {
  return (
    PROMPT_COLOURS.find((c) => c.id === appearance.promptColour) ??
    PROMPT_COLOURS.find((c) => c.id === DEFAULT_PROMPT_COLOUR)!
  );
}

export function withLook(appearance: Appearance, id: string, change: Partial<KingdomLook>): Appearance {
  return { ...appearance, looks: { ...appearance.looks, [id]: { ...appearance.looks?.[id], ...change } } };
}

export function withTabStyle(appearance: Appearance, style: TabStyle): Appearance {
  return { ...appearance, tabStyle: style };
}

export function withPromptColour(appearance: Appearance, id: string): Appearance {
  return { ...appearance, promptColour: id };
}

const CACHE_KEY = 'crystal-bridge.appearance';

/** The last appearance this browser saw; storage can be missing, blocked or hold something stale. */
export function loadCachedAppearance(storage: Storage | undefined = globalThis.localStorage): Appearance {
  try {
    const raw = storage?.getItem(CACHE_KEY);
    const parsed = raw ? Appearance.safeParse(JSON.parse(raw)) : undefined;
    return parsed?.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function cacheAppearance(appearance: Appearance, storage: Storage | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(CACHE_KEY, JSON.stringify(appearance));
  } catch {
    // Not cached; the hub still has it.
  }
}

/** The user's appearance from the hub, or undefined when it can't be had. */
export async function fetchAppearance(): Promise<Appearance | undefined> {
  try {
    const response = await fetch('/api/appearance');
    if (!response.ok) return undefined;
    const parsed = Appearance.safeParse(await response.json());
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Caches the appearance here and saves it to the hub, which passes it to the user's other open tabs. */
export async function saveAppearance(
  appearance: Appearance,
  storage: Storage | undefined = globalThis.localStorage,
): Promise<void> {
  cacheAppearance(appearance, storage);
  const response = await fetch('/api/appearance', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(appearance),
  });
  if (!response.ok) throw new Error(`the hub refused the appearance (${response.status})`);
}
