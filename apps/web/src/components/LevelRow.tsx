import type { HeroManifest } from '../heroes.js';
import type { Level } from '../levels.js';
import { HeroSprite } from './HeroSprite.js';

/** One Hero and their level: a sprite, "Lv N" and a bar to the next level, for the Roster and the Garrison. */
export function LevelRow({
  manifest,
  id,
  name,
  level,
  badge,
}: {
  manifest: HeroManifest;
  id: string;
  name: string;
  level: Level;
  /** A short mark beside the name, such as the Kingdom's leader. */
  badge?: string | undefined;
}) {
  return (
    <li className="flex items-center gap-2 rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1.5 dark:border-neutral-800 dark:bg-neutral-900">
      <HeroSprite manifest={manifest} classId={id} state="resting" size={32} decorative />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="font-medium">
            {name}
            {badge && <span className="ml-1.5 text-xs font-normal text-neutral-500">{badge}</span>}
          </span>
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
  );
}
