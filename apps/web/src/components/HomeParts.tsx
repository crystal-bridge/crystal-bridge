import { useContext, useState, type ReactNode } from 'react';
import { type HeroManifest, type HeroState, LeaderContext } from '../heroes.js';
import type { TurnStats } from '../home.js';
import { duration, tokens } from '../format.js';
import { questName, questTitle } from '../quests.js';
import { hint, w } from '../theme/words.js';
import { HeroSprite } from './HeroSprite.js';
import type { SessionSummary } from './SessionList.js';
import { Gold } from './Gold.js';

/** The Airship's and Castle's column: most of a wide screen, with a limit so lines stay readable on a huge one. */
export const HOME_PAGE = 'mx-auto w-full max-w-[110rem]';
/** Two blocks side by side once each has room for a full row of tiles, stacked otherwise. */
export const HOME_PAIR = 'grid grid-cols-[repeat(auto-fit,minmax(min(100%,36rem),1fr))] items-start gap-4';
/** Quest cards: as many columns as fit, without one card stretching across the page. */
export const QUEST_GRID = 'grid grid-cols-[repeat(auto-fill,minmax(min(100%,24rem),1fr))] gap-2';

/** "5m", "3h", "2d": how long ago. */
export function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

/** A row of totals: turns, Gold, time, tokens and KOs. Nothing yet reads as a quiet zero, not an error. */
export function StatTiles({ title, plain, stats }: { title: string; plain: string; stats: TurnStats | null }) {
  const allTokens = stats
    ? stats.tokens.input + stats.tokens.output + stats.tokens.cacheRead + stats.tokens.cacheWrite
    : 0;
  const tiles: { concept: 'turns' | 'gold' | 'workingTime' | 'tokens' | 'kos'; value: ReactNode }[] = [
    { concept: 'turns', value: String(stats?.turns ?? 0) },
    { concept: 'gold', value: <Gold usd={stats?.costUsd ?? 0} /> },
    { concept: 'workingTime', value: duration(stats?.durationMs ?? 0) },
    { concept: 'tokens', value: tokens(allTokens) },
    { concept: 'kos', value: String(stats?.kos ?? 0) },
  ];
  return (
    <section aria-label={title} className="space-y-1">
      <h2 className="cb-display px-3 text-xl leading-none" title={plain}>
        {title}
      </h2>
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(6.5rem,1fr))] gap-2 px-3">
        {tiles.map((tile) => (
          <div
            key={tile.concept}
            className="rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1.5 dark:border-neutral-800 dark:bg-neutral-900"
          >
            <dt className="text-xs text-neutral-500" title={hint(tile.concept)}>
              {w(tile.concept)}
            </dt>
            <dd className="whitespace-nowrap font-mono text-base tabular-nums">{tile.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * A finished Quest not yet viewed: a gold dot, or a rose one with a × for a failure, so it never rests on colour alone.
 * Marks, never asks: blue and "!" mean needs you.
 */
export function UnseenMark({ reason }: { reason: 'done' | 'failed' }) {
  const text = reason === 'done' ? 'Finished, not viewed yet' : 'Failed, not viewed yet';
  return (
    <span
      role="img"
      aria-label={text}
      title={text}
      data-unseen={reason}
      className={
        reason === 'done'
          ? 'inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-gold'
          : 'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-rose-500 text-[10px] font-bold leading-none text-white'
      }
    >
      {reason === 'failed' ? '×' : null}
    </span>
  );
}

/**
 * A Quest as a card: its leader Hero in its state (or a status dot), title, folder, last activity and, unless the
 * caller hides it (Discreet, cross-Kingdom), the start of its latest reply.
 */
export function QuestCard({
  session,
  waiting,
  unseen,
  heroes,
  state,
  showDetail = true,
  now,
  onOpen,
}: {
  session: SessionSummary;
  waiting: boolean;
  /** Finished since you last viewed it, and how. */
  unseen?: 'done' | 'failed' | undefined;
  heroes?: HeroManifest | null;
  state?: HeroState;
  /** False for a Discreet Kingdom outside its own Castle: no title or preview. */
  showDetail?: boolean;
  now: number;
  onOpen: () => void;
}) {
  const leaderOf = useContext(LeaderContext);
  const folder = session.cwd.split('/').filter(Boolean).at(-1) ?? session.cwd;
  const label = showDetail ? questName(session) : `A ${w('quest')}`;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={showDetail ? questTitle(session) : undefined}
      className="flex h-full w-full min-w-0 items-start gap-3 rounded-md border border-neutral-200 bg-white px-3 py-2 text-left hover:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-950 dark:hover:border-neutral-600"
    >
      <span className="flex h-10 w-10 shrink-0 items-end justify-center">
        {heroes ? (
          <HeroSprite
            manifest={heroes}
            classId={leaderOf(session.id) ?? heroes.leader}
            state={state ?? 'resting'}
            size={40}
            decorative
          />
        ) : (
          <span
            className={`mb-3 h-2.5 w-2.5 rounded-full ${session.status === 'running' ? 'bg-green-500' : 'bg-amber-400'}`}
          />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="truncate font-medium">{label}</span>
          {waiting && (
            <span className="shrink-0 rounded-full bg-amber-500 px-1.5 text-xs font-bold leading-4 text-white">!</span>
          )}
          {!waiting && unseen && <UnseenMark reason={unseen} />}
          <span className="ml-auto shrink-0 text-xs text-neutral-500">
            {ago(session.lastActivity ?? session.createdAt, now)}
          </span>
        </span>
        {showDetail && <span className="block truncate text-xs text-neutral-500">{folder}</span>}
        {showDetail && session.preview && (
          <span className="mt-0.5 block truncate text-sm text-neutral-600 dark:text-neutral-400">
            {session.preview}
          </span>
        )}
      </span>
    </button>
  );
}

/** A section folded away until asked for: history and extras stay one click off the main view. */
export function Folded({
  title,
  plain,
  count,
  children,
}: {
  title: string;
  plain: string;
  count?: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="border-t border-neutral-200 pt-2 dark:border-neutral-800">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title={plain}
        className="flex w-full items-baseline gap-2 px-3 py-1 text-left hover:text-neutral-950 dark:hover:text-white"
      >
        <span aria-hidden className="w-3 text-neutral-400">
          {open ? '▾' : '▸'}
        </span>
        <span className="cb-display text-2xl leading-none">{title}</span>
        {count !== undefined && <span className="text-xs text-neutral-500">{count}</span>}
      </button>
      {open && <div className="pt-1">{children}</div>}
    </section>
  );
}
