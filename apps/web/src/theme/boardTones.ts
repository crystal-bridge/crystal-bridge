/**
 * Colours on a Board (docs/THEME.md): a stable colour per sender and per project, one per kind of action, an accent per
 * banner tile, and the tones a projects Board's marks and chips name.
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

/** The tones a mark or chip can name (a `ScoutLook.tone`), and the ones an action chip uses. */
export const MARK_TONES = [
  'slate',
  'red',
  'orange',
  'violet',
  'amber',
  'emerald',
  'rose',
  'sky',
  'blue',
  'teal',
  'fuchsia',
  'lime',
  'neutral',
] as const;
export type ChipTone = (typeof MARK_TONES)[number];

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
  teal: 'bg-teal-100 text-teal-800 ring-teal-300 dark:bg-teal-950 dark:text-teal-200 dark:ring-teal-800',
  fuchsia:
    'bg-fuchsia-100 text-fuchsia-800 ring-fuchsia-300 dark:bg-fuchsia-950 dark:text-fuchsia-200 dark:ring-fuchsia-800',
  lime: 'bg-lime-100 text-lime-900 ring-lime-300 dark:bg-lime-950 dark:text-lime-200 dark:ring-lime-800',
  neutral:
    'bg-neutral-100 text-neutral-800 ring-neutral-300 dark:bg-neutral-800 dark:text-neutral-100 dark:ring-neutral-600',
};

/** A chip's classes for a tone name, slate for one not listed. */
export function toneChipClass(tone: string | undefined): string {
  return tone !== undefined && Object.hasOwn(CHIP_CLASSES, tone) ? CHIP_CLASSES[tone as ChipTone] : CHIP_CLASSES.slate;
}

/** A mark's text colour in each tone. */
export const MARK_CLASSES: Record<ChipTone, string> = {
  slate: 'text-slate-600 dark:text-slate-400',
  red: 'text-red-600 dark:text-red-400',
  orange: 'text-orange-600 dark:text-orange-400',
  violet: 'text-violet-600 dark:text-violet-400',
  amber: 'text-amber-600 dark:text-amber-400',
  emerald: 'text-emerald-600 dark:text-emerald-400',
  rose: 'text-rose-600 dark:text-rose-400',
  sky: 'text-sky-600 dark:text-sky-400',
  blue: 'text-blue-600 dark:text-blue-400',
  teal: 'text-teal-600 dark:text-teal-400',
  fuchsia: 'text-fuchsia-600 dark:text-fuchsia-400',
  lime: 'text-lime-600 dark:text-lime-400',
  neutral: 'text-neutral-600 dark:text-neutral-400',
};

/** A mark's text colour for a tone name, slate for one not listed. */
export function markToneClass(tone: string | undefined): string {
  return tone !== undefined && Object.hasOwn(MARK_CLASSES, tone) ? MARK_CLASSES[tone as ChipTone] : MARK_CLASSES.slate;
}

/** A project's colour, stable from its name and shared with the sender colours. */
export function projectTone(name: string): SenderTone {
  return senderTone(name);
}

/** A project's header wash, fading from its colour, and its small square dot (as in the Needs-you window). */
export const PROJECT_CLASSES: Record<SenderTone, { wash: string; dot: string }> = {
  rose: { wash: 'from-rose-100 dark:from-rose-900/45', dot: 'bg-rose-500 dark:bg-rose-400' },
  orange: { wash: 'from-orange-100 dark:from-orange-900/45', dot: 'bg-orange-500 dark:bg-orange-400' },
  amber: { wash: 'from-amber-100 dark:from-amber-900/45', dot: 'bg-amber-500 dark:bg-amber-400' },
  lime: { wash: 'from-lime-100 dark:from-lime-900/45', dot: 'bg-lime-500 dark:bg-lime-400' },
  emerald: { wash: 'from-emerald-100 dark:from-emerald-900/45', dot: 'bg-emerald-500 dark:bg-emerald-400' },
  teal: { wash: 'from-teal-100 dark:from-teal-900/45', dot: 'bg-teal-500 dark:bg-teal-400' },
  sky: { wash: 'from-sky-100 dark:from-sky-900/45', dot: 'bg-sky-500 dark:bg-sky-400' },
  blue: { wash: 'from-blue-100 dark:from-blue-900/45', dot: 'bg-blue-500 dark:bg-blue-400' },
  violet: { wash: 'from-violet-100 dark:from-violet-900/45', dot: 'bg-violet-500 dark:bg-violet-400' },
  fuchsia: { wash: 'from-fuchsia-100 dark:from-fuchsia-900/45', dot: 'bg-fuchsia-500 dark:bg-fuchsia-400' },
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

/**
 * Banner tile accents, in tile order, for a tile that names no tone. The built-in tiles name theirs (sky, amber, violet,
 * fuchsia), so the cycle starts with the others.
 */
export const TILE_TONES = ['teal', 'lime', 'rose', 'indigo', 'blue', 'amber', 'violet', 'sky', 'fuchsia'] as const;
export type TileTone = (typeof TILE_TONES)[number];

export const TILE_CLASSES: Record<TileTone | ChipTone, { border: string; value: string }> = {
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
  slate: { border: 'border-l-slate-500 dark:border-l-slate-400', value: 'text-slate-700 dark:text-slate-300' },
  red: { border: 'border-l-red-500 dark:border-l-red-400', value: 'text-red-700 dark:text-red-300' },
  orange: { border: 'border-l-orange-500 dark:border-l-orange-400', value: 'text-orange-700 dark:text-orange-300' },
  emerald: {
    border: 'border-l-emerald-500 dark:border-l-emerald-400',
    value: 'text-emerald-700 dark:text-emerald-300',
  },
  neutral: {
    border: 'border-l-neutral-500 dark:border-l-neutral-400',
    value: 'text-neutral-700 dark:text-neutral-300',
  },
  indigo: { border: 'border-l-indigo-500 dark:border-l-indigo-400', value: 'text-indigo-700 dark:text-indigo-300' },
};

/** A banner tile's tone: the Scout's own when it names one we know, else the cycle by position. */
export function tileTone(index: number, tone?: string): TileTone | ChipTone {
  return tone !== undefined && Object.hasOwn(TILE_CLASSES, tone)
    ? (tone as TileTone | ChipTone)
    : TILE_TONES[index % TILE_TONES.length]!;
}
