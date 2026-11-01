import type { Cast, Summon } from '@crystal-bridge/protocol';
import { castLine, hint, w } from '../theme/words.js';

export interface SummoningCircleProps {
  summons: readonly Summon[];
  casts: readonly Cast[];
  now: number;
  /** This Kingdom's name, which stands in for `here` on its own Casts. */
  kingdom: string;
}

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

/** Running first, then waiting for a turn, then ended. */
function rank(cast: Cast): number {
  if (cast.state !== 'running') return 2;
  return cast.queued ? 1 : 0;
}

function CastRow({ cast, now, kingdom }: { cast: Cast; now: number; kingdom: string }) {
  const summon = cast.summon === 'here' ? kingdom : cast.summon;
  const line = castLine(cast, summon);
  const { progress } = cast;
  return (
    <li className="py-1.5">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${cast.queued ? 'bg-neutral-400' : STATE_DOT[cast.state]}`} />
        <span className="min-w-0 flex-1 truncate font-medium" title={`${line.plain}: ${cast.command}`}>
          {line.themed}
        </span>
        <span className="shrink-0 text-xs text-neutral-500">
          {summon} · {took((cast.finishedAt ?? now) - cast.startedAt)}
        </span>
      </div>
      {progress && cast.state === 'running' && (
        <div className="mt-1 flex items-center gap-2 pl-4">
          <span
            role="progressbar"
            aria-label={cast.name}
            aria-valuemin={0}
            aria-valuenow={Math.min(progress.done, progress.total)}
            aria-valuemax={progress.total}
            className="block h-1.5 min-w-0 flex-1 overflow-hidden rounded bg-neutral-200 dark:bg-neutral-800"
          >
            <span
              className="block h-full bg-amber-400"
              style={{ width: `${Math.min(100, (progress.done / progress.total) * 100)}%` }}
            />
          </span>
          {progress.label && <span className="max-w-[50%] truncate text-xs text-neutral-500">{progress.label}</span>}
        </div>
      )}
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
export function SummoningCircle({ summons, casts, now, kingdom }: SummoningCircleProps) {
  const running = (name: string) => casts.filter((cast) => cast.summon === name && rank(cast) === 0).length;
  const shown = summons.filter((summon) => !summon.local || running(summon.name) > 0);
  const ordered = [...casts].sort((a, b) => rank(a) - rank(b) || b.startedAt - a.startedAt);
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
            <CastRow key={cast.id} cast={cast} now={now} kingdom={kingdom} />
          ))}
        </ul>
      )}
    </section>
  );
}
