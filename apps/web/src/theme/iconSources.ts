/**
 * Where each of the app's icons comes from: an Iconify icon pack and the icon's name in it (picked in the "Quest UI
 * Audition", #17). Themed concepts use Game-icons, plain UI uses Phosphor's filled weight. `pnpm icons` copies the
 * drawings into `iconData.ts`, so the packs are build tools only; a fork changes an icon here and regenerates.
 */
export const ICON_PACKS = {
  'game-icons': {
    name: 'Game-icons',
    url: 'https://game-icons.net',
    licence: 'CC BY 3.0',
  },
  ph: {
    name: 'Phosphor Icons',
    url: 'https://phosphoricons.com',
    licence: 'MIT',
  },
} as const;

export type IconPack = keyof typeof ICON_PACKS;

export interface IconSource {
  pack: IconPack;
  icon: string;
  /** The artist, where the pack's licence asks for credit per icon (Game-icons). */
  author?: string;
}

export const ICON_SOURCES = {
  // Quest toolbar
  fork: { pack: 'ph', icon: 'git-fork-fill' },
  split: { pack: 'ph', icon: 'columns-fill' },
  exitSplit: { pack: 'ph', icon: 'rectangle-fill' },
  details: { pack: 'ph', icon: 'sidebar-simple-fill' },
  inventory: { pack: 'game-icons', icon: 'knapsack', author: 'Lorc' },
  close: { pack: 'game-icons', icon: 'flag-objective', author: 'Delapouite' },
  // Inventory categories
  spells: { pack: 'game-icons', icon: 'spell-book', author: 'Delapouite' },
  items: { pack: 'game-icons', icon: 'round-potion', author: 'Caro Asercion' },
  equipment: { pack: 'ph', icon: 'sword-fill' },
  abilities: { pack: 'game-icons', icon: 'lightning-helix', author: 'Lorc' },
  // Prompt box
  attach: { pack: 'ph', icon: 'plus-bold' },
  send: { pack: 'game-icons', icon: 'arrow-wings', author: 'Delapouite' },
  stop: { pack: 'game-icons', icon: 'hand', author: 'Sbed' },
  mode: { pack: 'game-icons', icon: 'checked-shield', author: 'Lorc' },
  // Stats
  hp: { pack: 'game-icons', icon: 'hearts', author: 'Skoll' },
  mp: { pack: 'game-icons', icon: 'magic-swirl', author: 'Lorc' },
  gold: { pack: 'game-icons', icon: 'two-coins', author: 'Delapouite' },
  info: { pack: 'ph', icon: 'info-fill' },
} as const satisfies Record<string, IconSource>;

export type IconName = keyof typeof ICON_SOURCES;

/** The Game-icons artists whose icons the app uses, for Credits. */
export function iconAuthors(pack: IconPack): string[] {
  const authors = Object.values(ICON_SOURCES as Record<string, IconSource>)
    .filter((source) => source.pack === pack && source.author)
    .map((source) => source.author!);
  return [...new Set(authors)].sort();
}
