import type { Cast, Summon } from '@crystal-bridge/protocol';
import { hint, w } from '../theme/words.js';

export interface SummoningCircleProps {
  summons: readonly Summon[];
  casts: readonly Cast[];
  now: number;
}

const STATE_WORD: Record<Cast['state'], string> = {
  running: 'running',
  succeeded: 'finished',
  failed: 'failed',
  cancelled: 'cancelled',
  lost: 'lost',
};

const STATE_DOT: Record<Cast['state'], string> = {
  running: 'bg-amber-400',
  succeeded: 'bg-green-500',
  failed: 'bg-red-500',
  cancelled: 'bg-neutral-400',
  lost: 'bg-red-500',
};

function took(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.floor(ms / 1000)}s`;
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Whether a Kingdom has anything to show: it's always its own target, which alone is no reason for a panel. */
export function hasCircle(summons: readonly Summon[], casts: readonly Cast[]): boolean {
  return casts.length > 0 || summons.some((summon) => !summon.local);
}

function CastRow({ cast, now }: { cast: Cast; now: number }) {
  const code = cast.exitCode !== undefined && cast.state === 'failed' ? ` · exit ${cast.exitCode}` : '';
  return (
    <li className="py-1.5">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${STATE_DOT[cast.state]}`} />
        <span className="min-w-0 flex-1 truncate font-medium" title={cast.command}>
          {cast.name}
        </span>
        <span className="shrink-0 text-xs text-neutral-500">
          {cast.summon} · {STATE_WORD[cast.state]}
          {code} · {took((cast.finishedAt ?? now) - cast.startedAt)}
        </span>
      </div>
      {cast.logTail && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-neutral-500">Log</summary>
          <pre className="mt-1 max-h-60 overflow-auto rounded bg-neutral-100 p-2 text-xs dark:bg-neutral-900">
            {cast.logTail}
          </pre>
        </details>
      )}
    </li>
  );
}

/** A Kingdom's Summons and their Casts, running and past, from the hub's record (docs/SUMMONS.md). */
export function SummoningCircle({ summons, casts, now }: SummoningCircleProps) {
  const running = (name: string) => casts.filter((cast) => cast.summon === name && cast.state === 'running').length;
  const shown = summons.filter((summon) => !summon.local || running(summon.name) > 0);
  const ordered = [...casts].sort(
    (a, b) => Number(b.state === 'running') - Number(a.state === 'running') || b.startedAt - a.startedAt,
  );
  return (
    <section aria-label={w('summoningCircle')} className="space-y-2">
      <h2 className="cb-display text-2xl leading-none" title={hint('summoningCircle')}>
        {w('summoningCircle')}
      </h2>
      {shown.length > 0 && (
        <ul aria-label={w('summons')} className="flex flex-wrap gap-2">
          {shown.map((summon) => (
            <li
              key={summon.name}
              className="flex items-center gap-2 rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700"
            >
              <span className="font-medium">{summon.name}</span>
              {running(summon.name) > 0 && (
                <span className="text-xs text-neutral-500">{running(summon.name)} running</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {ordered.length === 0 ? (
        <p className="text-sm text-neutral-500">{`No ${w('casts')} yet. A ${w('quest')} starts them.`}</p>
      ) : (
        <ul aria-label={w('casts')} className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {ordered.map((cast) => (
            <CastRow key={cast.id} cast={cast} now={now} />
          ))}
        </ul>
      )}
    </section>
  );
}
