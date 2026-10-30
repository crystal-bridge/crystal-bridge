import type { HeroManifest } from '../heroes.js';
import { type Level, levelFor } from '../levels.js';
import { hint, w } from '../theme/words.js';
import { HeroSprite } from './HeroSprite.js';

/**
 * Every Hero Class with its level (#23), highest first: a sprite, "Lv N" and a bar to the next level. Pointless on
 * purpose; a rough measure of which Classes have led the most Quests.
 */
export function Roster({ manifest, levels }: { manifest: HeroManifest; levels: Record<string, Level> }) {
  const rows = Object.entries(manifest.classes)
    .map(([id, cls]) => ({ id, name: cls.name, level: levels[id] ?? levelFor(0) }))
    .sort((a, b) => b.level.xp - a.level.xp || a.name.localeCompare(b.name));
  return (
    <section aria-label={w('roster')} className="space-y-1">
      <h2 className="cb-display text-xl leading-none" title={hint('roster')}>
        {w('roster')}
      </h2>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map(({ id, name, level }) => (
          <li
            key={id}
            className="flex items-center gap-2 rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1.5 dark:border-neutral-800 dark:bg-neutral-900"
          >
            <HeroSprite manifest={manifest} classId={id} state="resting" size={32} decorative />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2">
                <span className="font-medium">{name}</span>
                <span className="cb-display text-amber-700 dark:text-gold-bright" title={`${level.xp} XP`}>
                  Lv {level.level}
                </span>
              </span>
              <span
                role="meter"
                aria-label={`${name} XP to the next level`}
                aria-valuemin={0}
                aria-valuemax={level.span}
                aria-valuenow={level.into}
                title={`${level.into} of ${level.span} XP to Lv ${level.level + 1}`}
                className="mt-1 block h-1 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800"
              >
                <span className="block h-full bg-amber-500" style={{ width: `${(level.into / level.span) * 100}%` }} />
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
