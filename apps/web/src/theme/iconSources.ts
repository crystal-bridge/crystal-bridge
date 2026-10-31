/**
 * Where each of the app's icons comes from: an Iconify icon pack and the icon's name in it (picked in the "Quest UI
 * Audition", #17, and the "Inventory Audition", #78). Themed concepts use Game-icons, plain UI uses Phosphor's filled weight. `pnpm icons` copies the
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
  // App bar
  settings: { pack: 'game-icons', icon: 'gear-hammer', author: 'Lorc' },
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
  equipment: { pack: 'game-icons', icon: 'battle-gear', author: 'Lorc' },
  relics: { pack: 'game-icons', icon: 'holy-grail', author: 'Lorc' },
  guild: { pack: 'game-icons', icon: 'barracks-tent', author: 'Delapouite' },
  abilities: { pack: 'game-icons', icon: 'lightning-helix', author: 'Lorc' },
  // The Belt
  belt: { pack: 'game-icons', icon: 'belt', author: 'Lucas' },
  instant: { pack: 'game-icons', icon: 'lightning-arc', author: 'Lorc' },
  edit: { pack: 'ph', icon: 'pencil-simple-fill' },
  // Prompt box
  attach: { pack: 'ph', icon: 'plus-bold' },
  // Send attacks, Stop blocks (the owner's picks, 2026-10-30).
  send: { pack: 'game-icons', icon: 'broadsword', author: 'Lorc' },
  stop: { pack: 'game-icons', icon: 'shield', author: 'Sbed' },
  mode: { pack: 'game-icons', icon: 'checked-shield', author: 'Lorc' },
  effort: { pack: 'game-icons', icon: 'flame', author: 'Carl Olsen' },
  // The Armory (theme/armory.ts): the only icons a Belt slot picks from.
  anvilImpact: { pack: 'game-icons', icon: 'anvil-impact', author: 'Lorc' },
  gearHammer: { pack: 'game-icons', icon: 'gear-hammer', author: 'Lorc' },
  wrench: { pack: 'game-icons', icon: 'wrench', author: 'Sbed' },
  gears: { pack: 'game-icons', icon: 'gears', author: 'Lorc' },
  fireball: { pack: 'game-icons', icon: 'fireball', author: 'Lorc' },
  bubblingFlask: { pack: 'game-icons', icon: 'bubbling-flask', author: 'Lorc' },
  testTubes: { pack: 'game-icons', icon: 'test-tubes', author: 'Lorc' },
  bugNet: { pack: 'game-icons', icon: 'bug-net', author: 'Delapouite' },
  magnifyingGlass: { pack: 'game-icons', icon: 'magnifying-glass', author: 'Lorc' },
  bullseye: { pack: 'game-icons', icon: 'bullseye', author: 'Skoll' },
  rocket: { pack: 'game-icons', icon: 'rocket', author: 'Lorc' },
  sail: { pack: 'game-icons', icon: 'sail', author: 'Delapouite' },
  shipWheel: { pack: 'game-icons', icon: 'ship-wheel', author: 'Delapouite' },
  portal: { pack: 'game-icons', icon: 'portal', author: 'Lorc' },
  familyTree: { pack: 'game-icons', icon: 'family-tree', author: 'Delapouite' },
  cycle: { pack: 'game-icons', icon: 'cycle', author: 'Lorc' },
  treasureMap: { pack: 'game-icons', icon: 'treasure-map', author: 'Lorc' },
  compass: { pack: 'game-icons', icon: 'compass', author: 'Lorc' },
  brainstorm: { pack: 'game-icons', icon: 'brainstorm', author: 'Lorc' },
  hourglass: { pack: 'game-icons', icon: 'hourglass', author: 'Lorc' },
  sundial: { pack: 'game-icons', icon: 'sundial', author: 'Lorc' },
  calendar: { pack: 'game-icons', icon: 'calendar', author: 'Delapouite' },
  quillInk: { pack: 'game-icons', icon: 'quill-ink', author: 'Lorc' },
  scrollUnfurled: { pack: 'game-icons', icon: 'scroll-unfurled', author: 'Lorc' },
  openBook: { pack: 'game-icons', icon: 'open-book', author: 'Lorc' },
  spyglass: { pack: 'game-icons', icon: 'spyglass', author: 'Lorc' },
  telescope: { pack: 'game-icons', icon: 'telescope', author: 'Delapouite' },
  crystalBall: { pack: 'game-icons', icon: 'crystal-ball', author: 'Lorc' },
  brain: { pack: 'game-icons', icon: 'brain', author: 'Lorc' },
  wireframeGlobe: { pack: 'game-icons', icon: 'wireframe-globe', author: 'Delapouite' },
  padlock: { pack: 'game-icons', icon: 'padlock', author: 'Lorc' },
  skeletonKey: { pack: 'game-icons', icon: 'skeleton-key', author: 'Lorc' },
  broom: { pack: 'game-icons', icon: 'broom', author: 'Delapouite' },
  trashCan: { pack: 'game-icons', icon: 'trash-can', author: 'Delapouite' },
  recycle: { pack: 'game-icons', icon: 'recycle', author: 'Lorc' },
  envelope: { pack: 'game-icons', icon: 'envelope', author: 'Lorc' },
  ringingBell: { pack: 'game-icons', icon: 'ringing-bell', author: 'Lorc' },
  raven: { pack: 'game-icons', icon: 'raven', author: 'Lorc' },
  bugleCall: { pack: 'game-icons', icon: 'bugle-call', author: 'Lorc' },
  magicPotion: { pack: 'game-icons', icon: 'magic-potion', author: 'Delapouite' },
  healthPotion: { pack: 'game-icons', icon: 'health-potion', author: 'Delapouite' },
  campfire: { pack: 'game-icons', icon: 'campfire', author: 'Lorc' },
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
