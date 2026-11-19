/**
 * Colours on a Board (docs/THEME.md): a stable colour per sender, one per kind of action, and an accent per banner tile.
 * Data, so a fork changes the palette here. Each class is written out whole, so the stylesheet build keeps it.
 */

/** Sender colours, in hash order. */
export const SENDER_TONES = [
  'rose',
  'orange',
  'amber',
  'lime',
  'emerald',
  'teal',
  'sky',
  'blue',
  'violet',
  'fuchsia',
] as const;
export type SenderTone = (typeof SENDER_TONES)[number];

/** A sender's avatar, and its name a shade darker so it reads as text. */
export const SENDER_CLASSES: Record<SenderTone, { avatar: string; text: string }> = {
  rose: {
    avatar: 'bg-rose-200 text-rose-950 dark:bg-rose-800 dark:text-rose-50',
    text: 'text-rose-700 dark:text-rose-300',
  },
  orange: {
    avatar: 'bg-orange-200 text-orange-950 dark:bg-orange-800 dark:text-orange-50',
    text: 'text-orange-700 dark:text-orange-300',
  },
  amber: {
    avatar: 'bg-amber-200 text-amber-950 dark:bg-amber-800 dark:text-amber-50',
    text: 'text-amber-700 dark:text-amber-300',
  },
  lime: {
    avatar: 'bg-lime-200 text-lime-950 dark:bg-lime-800 dark:text-lime-50',
    text: 'text-lime-700 dark:text-lime-300',
  },
  emerald: {
    avatar: 'bg-emerald-200 text-emerald-950 dark:bg-emerald-800 dark:text-emerald-50',
    text: 'text-emerald-700 dark:text-emerald-300',
  },
  teal: {
    avatar: 'bg-teal-200 text-teal-950 dark:bg-teal-800 dark:text-teal-50',
    text: 'text-teal-700 dark:text-teal-300',
  },
  sky: { avatar: 'bg-sky-200 text-sky-950 dark:bg-sky-800 dark:text-sky-50', text: 'text-sky-700 dark:text-sky-300' },
  blue: {
    avatar: 'bg-blue-200 text-blue-950 dark:bg-blue-800 dark:text-blue-50',
    text: 'text-blue-700 dark:text-blue-300',
  },
  violet: {
    avatar: 'bg-violet-200 text-violet-950 dark:bg-violet-800 dark:text-violet-50',
    text: 'text-violet-700 dark:text-violet-300',
  },
  fuchsia: {
    avatar: 'bg-fuchsia-200 text-fuchsia-950 dark:bg-fuchsia-800 dark:text-fuchsia-50',
    text: 'text-fuchsia-700 dark:text-fuchsia-300',
  },
};

/** One sender's colour, from a stable key such as the address: the same key gets the same colour everywhere. */
export function senderTone(key: string): SenderTone {
  // FNV-1a over the normalised key: cheap, and spreads short, similar keys.
  let hash = 0x811c9dc5;
  for (const char of key.trim().toLowerCase()) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return SENDER_TONES[hash % SENDER_TONES.length]!;
}

export type ChipTone = 'slate' | 'red' | 'orange' | 'violet' | 'amber' | 'emerald' | 'rose' | 'sky' | 'blue';

/** A chip in each tone. */
export const CHIP_CLASSES: Record<ChipTone, string> = {
  slate: 'bg-slate-100 text-slate-800 ring-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-600',
  red: 'bg-red-100 text-red-800 ring-red-300 dark:bg-red-950 dark:text-red-200 dark:ring-red-800',
  orange: 'bg-orange-100 text-orange-800 ring-orange-300 dark:bg-orange-950 dark:text-orange-200 dark:ring-orange-800',
  violet: 'bg-violet-100 text-violet-800 ring-violet-300 dark:bg-violet-950 dark:text-violet-200 dark:ring-violet-800',
  amber: 'bg-amber-100 text-amber-900 ring-amber-300 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-800',
  emerald:
    'bg-emerald-100 text-emerald-800 ring-emerald-300 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-800',
  rose: 'bg-rose-100 text-rose-800 ring-rose-300 dark:bg-rose-950 dark:text-rose-200 dark:ring-rose-800',
  sky: 'bg-sky-100 text-sky-800 ring-sky-300 dark:bg-sky-950 dark:text-sky-200 dark:ring-sky-800',
  blue: 'bg-blue-100 text-blue-800 ring-blue-300 dark:bg-blue-950 dark:text-blue-200 dark:ring-blue-800',
};

/** Action keys with a colour of their own, by what they usually mean. */
const BY_KEY: Record<string, ChipTone> = { archive: 'slate', spam: 'red', filter: 'orange' };
/** Else, by the kind of action. */
const BY_KIND: Record<string, ChipTone> = {
  quest: 'violet',
  snooze: 'amber',
  done: 'emerald',
  dismiss: 'rose',
  link: 'sky',
  run: 'blue',
};

/** An action's chip colour. */
export function actionTone(key: string, kind: string): ChipTone {
  if (Object.hasOwn(BY_KEY, key)) return BY_KEY[key]!;
  return Object.hasOwn(BY_KIND, kind) ? BY_KIND[kind]! : 'slate';
}

/** Banner tile accents, in tile order. */
export const TILE_TONES = ['blue', 'amber', 'violet', 'sky', 'teal', 'fuchsia', 'lime', 'rose', 'indigo'] as const;
export type TileTone = (typeof TILE_TONES)[number];

export const TILE_CLASSES: Record<TileTone, { border: string; value: string }> = {
  blue: { border: 'border-l-blue-500 dark:border-l-blue-400', value: 'text-blue-700 dark:text-blue-300' },
  amber: { border: 'border-l-amber-500 dark:border-l-amber-400', value: 'text-amber-700 dark:text-amber-300' },
  violet: { border: 'border-l-violet-500 dark:border-l-violet-400', value: 'text-violet-700 dark:text-violet-300' },
  sky: { border: 'border-l-sky-500 dark:border-l-sky-400', value: 'text-sky-700 dark:text-sky-300' },
  teal: { border: 'border-l-teal-500 dark:border-l-teal-400', value: 'text-teal-700 dark:text-teal-300' },
  fuchsia: {
    border: 'border-l-fuchsia-500 dark:border-l-fuchsia-400',
    value: 'text-fuchsia-700 dark:text-fuchsia-300',
  },
  lime: { border: 'border-l-lime-500 dark:border-l-lime-400', value: 'text-lime-700 dark:text-lime-300' },
  rose: { border: 'border-l-rose-500 dark:border-l-rose-400', value: 'text-rose-700 dark:text-rose-300' },
  indigo: { border: 'border-l-indigo-500 dark:border-l-indigo-400', value: 'text-indigo-700 dark:text-indigo-300' },
};
