import type { IconName } from './iconSources.js';

/**
 * The Armory (docs/THEME.md): the small set of icons a Belt slot picks from, so nobody has to find one per item, and
 * the keyword rules that give any name a sensible one. Both are data: a fork changes them here. Each family shares a
 * colour (`.cb-family-<id>` in theme.css).
 */
export interface ArmoryFamily {
  id: string;
  icons: readonly IconName[];
}

export const ARMORY: readonly ArmoryFamily[] = [
  { id: 'forge', icons: ['anvilImpact', 'gearHammer', 'wrench', 'gears', 'fireball'] },
  { id: 'trials', icons: ['bubblingFlask', 'testTubes', 'bugNet', 'magnifyingGlass', 'bullseye'] },
  { id: 'voyage', icons: ['rocket', 'sail', 'shipWheel', 'portal', 'familyTree', 'cycle'] },
  { id: 'charts', icons: ['treasureMap', 'compass', 'brainstorm', 'hourglass', 'sundial', 'calendar'] },
  {
    id: 'lore',
    icons: [
      'quillInk',
      'scrollUnfurled',
      'openBook',
      'spyglass',
      'telescope',
      'crystalBall',
      'brain',
      'wireframeGlobe',
    ],
  },
  { id: 'wards', icons: ['padlock', 'skeletonKey', 'broom', 'trashCan', 'recycle'] },
  { id: 'heralds', icons: ['envelope', 'ringingBell', 'raven', 'bugleCall'] },
  { id: 'provisions', icons: ['magicPotion', 'healthPotion', 'campfire'] },
];

/** First match wins, so a specific rule goes before a broader one: `security-review` is about security. */
const ICON_RULES: readonly (readonly [RegExp, IconName])[] = [
  [/compact/, 'magicPotion'],
  [/clear|rest|reset/, 'campfire'],
  [/secur|secret|auth/, 'padlock'],
  [/test|tdd|spec|verif/, 'bubblingFlask'],
  [/debug|bug|fix/, 'bugNet'],
  [/review|audit|lint/, 'magnifyingGlass'],
  [/deploy|release|ship|publish/, 'rocket'],
  [/plan|roadmap/, 'treasureMap'],
  [/design|brainstorm|idea/, 'brainstorm'],
  [/doc|readme|write|note|changelog/, 'quillInk'],
  [/pdf|sheet|slide/, 'scrollUnfurled'],
  [/research|search|explore|find/, 'spyglass'],
  [/git|commit|branch|merge|\bpr\b/, 'familyTree'],
  [/loop|repeat|cron|schedule/, 'cycle'],
  [/clean|prune|tidy/, 'broom'],
  [/mail/, 'envelope'],
  [/calendar/, 'calendar'],
  [/memory|context|recall/, 'brain'],
  [/config|setting|init|setup/, 'gears'],
  [/build|forge|make/, 'anvilImpact'],
  [/web|browser|http|chrome/, 'wireframeGlobe'],
];

export function armoryIcons(): IconName[] {
  return ARMORY.flatMap((family) => family.icons);
}

/** The family an icon belongs to; undefined for an icon outside the Armory, which keeps its own colour. */
export function familyOf(icon: string): string | undefined {
  return ARMORY.find((family) => (family.icons as readonly string[]).includes(icon))?.id;
}

/** The Armory icon for a name, if a rule places it. */
export function iconForName(name: string): IconName | undefined {
  const lower = name.toLowerCase();
  return ICON_RULES.find(([rule]) => rule.test(lower))?.[1];
}
