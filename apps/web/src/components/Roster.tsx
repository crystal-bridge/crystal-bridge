import type { HeroManifest } from '../heroes.js';
import { type Level, levelFor } from '../levels.js';
import { hint, w } from '../theme/words.js';
import { LevelRow } from './LevelRow.js';

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
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,14rem),1fr))] gap-2">
        {rows.map(({ id, name, level }) => (
          <LevelRow key={id} manifest={manifest} id={id} name={name} level={level} />
        ))}
      </ul>
    </section>
  );
}
