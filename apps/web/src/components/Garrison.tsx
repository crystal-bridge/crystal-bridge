import type { HeroManifest } from '../heroes.js';
import type { Level } from '../levels.js';
import { hint, w } from '../theme/words.js';
import { LevelRow } from './LevelRow.js';

export interface GarrisonProps {
  manifest: HeroManifest;
  /** Levels from this Kingdom's Quests alone, for Heroes who have earned XP here. */
  levels: Record<string, Level>;
  /** The Class this Kingdom picked as its party leader. */
  leader?: string | undefined;
}

/**
 * Who fights here: the Hero Classes that have led Quests in this Kingdom, with their levels here, the leader first and
 * then highest first (#114). It's decoration, like the levels themselves. The Roster keeps the lifetime figures.
 */
export function Garrison({ manifest, levels, leader }: GarrisonProps) {
  const rows = Object.entries(levels)
    .flatMap(([id, level]) => {
      const cls = manifest.classes[id];
      return cls ? [{ id, name: cls.name, level }] : [];
    })
    .sort(
      (a, b) =>
        Number(b.id === leader) - Number(a.id === leader) || b.level.xp - a.level.xp || a.name.localeCompare(b.name),
    );
  return (
    <section aria-label={w('garrison')} className="space-y-1">
      <h2 className="cb-display text-2xl leading-none" title={hint('garrison')}>
        {w('garrison')}
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm text-neutral-500">{`No ${w('heroes')} here yet. ${w('heroes')} join once they've led a ${w('quest')} here.`}</p>
      ) : (
        <ul className="grid gap-2">
          {rows.map(({ id, name, level }) => (
            <LevelRow
              key={id}
              manifest={manifest}
              id={id}
              name={name}
              level={level}
              badge={id === leader ? 'Leader' : undefined}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
