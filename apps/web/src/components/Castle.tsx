import { type CSSProperties, type ReactNode, useState } from 'react';
import type { KingdomLook } from '../appearance.js';
import { KingdomIcon } from './KingdomIcon.js';
import { hint, w } from '../theme/words.js';
import type { Engine, ExternalSession } from '@crystal-bridge/protocol';
import type { Kingdom } from '../kingdoms.js';
import { isActiveQuest } from '../quests.js';
import { FoundSessions } from './FoundSessions.js';
import { NodeUsage, type NodeUsageRow } from './NodeUsage.js';
import { type SearchHit, SearchResults } from './SearchResults.js';
import { type SessionSummary, SessionList } from './SessionList.js';
import type { HeroManifest, HeroState } from '../heroes.js';
import { recentProjects, type TurnStats } from '../home.js';
import { QuestCard, StatTiles } from './HomeParts.js';

export interface CastleProps {
  kingdom: Kingdom;
  /** This Kingdom's Quests, newest first. */
  sessions: SessionSummary[];
  waiting: ReadonlySet<string>;
  usage: NodeUsageRow[];
  /** Sessions found outside the bridge, offered as Recruits. */
  found: ExternalSession[];
  /** Engines the Kingdom runs, for the Recruit engine choice. */
  engines?: Engine[];
  onAdopt: (id: string, engine?: Engine) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** The Kingdom search, inside the Chronicle. */
  query: string;
  onQuery: (query: string) => void;
  hits: SearchHit[];
  onOpenHit: (session: string) => void;
  /** This Kingdom's icon and colour on this device. */
  look?: KingdomLook;
  /** The Kingdom's Crystal release (its deployed commit), when it reports one. */
  release?: string;
  /** This Kingdom's finished turns since local midnight and since Monday. */
  today?: TurnStats | null;
  week?: TurnStats | null;
  /** Heroes for the Quest cards, when the theme has them. */
  heroes?: HeroManifest | null;
  heroStates?: Record<string, HeroState>;
  /** Starts a New Quest with this folder chosen. */
  onNewIn?: (cwd: string) => void;
  now?: number;
}

function Section({ title, plain, children }: { title: string; plain?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-1">
      <h2 className="cb-display px-3 text-2xl leading-none" title={plain}>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A section folded away until asked for: history and extras stay one click off the main view. */
function Folded({
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

/**
 * A Kingdom's home: what needs the user, the Quests in play, and New Quest up front; the Chronicle (history and
 * search) and Recruits folded away. The header flies the Kingdom's banner: its icon and colour on this device.
 */
export function Castle({
  kingdom,
  sessions,
  waiting,
  usage,
  found,
  engines,
  onAdopt,
  onSelect,
  onNew,
  query,
  onQuery,
  hits,
  onOpenHit,
  look,
  release,
  today = null,
  week = null,
  heroes,
  heroStates = {},
  onNewIn,
  now = Date.now(),
}: CastleProps) {
  const haunts = recentProjects(sessions);
  const card = (session: SessionSummary) => (
    <li key={session.id}>
      <QuestCard
        session={session}
        waiting={waiting.has(session.id)}
        heroes={heroes}
        state={heroStates[session.id]}
        now={now}
        onOpen={() => onSelect(session.id)}
      />
    </li>
  );
  const needsYou = sessions.filter((s) => waiting.has(s.id));
  const active = sessions.filter((s) => !waiting.has(s.id) && isActiveQuest(s, now, waiting));
  const history = sessions.filter((s) => !isActiveQuest(s, now, waiting));
  const searching = query.trim().length >= 2;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-5 py-6">
        <header
          data-kingdom={kingdom.id}
          style={look ? ({ '--kingdom-colour': look.colour } as CSSProperties) : undefined}
          className="mx-3 flex flex-wrap items-end justify-between gap-3 border-b-4 border-[var(--kingdom-colour,transparent)] pb-3"
        >
          <div className="flex items-center gap-3">
            {look && <KingdomIcon icon={look.icon} colour={look.colour} size={48} />}
            <div>
              <h1 className="cb-display text-4xl leading-none" title={hint('castle')}>
                {kingdom.name}
              </h1>
              <p className="text-sm text-neutral-500">
                {kingdom.connected ? 'Connected' : 'Offline: Quests start once it reconnects'}
                {release && <span title="Crystal release (deployed commit)"> · {release.slice(0, 7)}</span>}
                {engines && engines.length > 0 && (
                  <span title="engines this Kingdom runs"> · {engines.join(', ')}</span>
                )}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onNew}
            title={hint('newQuest')}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700"
          >
            {w('newQuest')}
          </button>
        </header>
        <NodeUsage rows={usage} now={now} named={false} />

        <div className="grid gap-4 md:grid-cols-2">
          <StatTiles title={w('today')} plain={hint('today')} stats={today} />
          <StatTiles title={w('thisWeek')} plain={hint('thisWeek')} stats={week} />
        </div>

        {needsYou.length > 0 && (
          <Section title={w('needsYou')} plain={hint('needsYou')}>
            <ul className="space-y-2 px-3">{needsYou.map(card)}</ul>
          </Section>
        )}

        <Section title={w('activeQuests')} plain={hint('activeQuests')}>
          {active.length === 0 ? (
            <p className="px-3 text-sm text-neutral-500">{`Nothing in play. Start one with ${w('newQuest')}.`}</p>
          ) : (
            <ul className="space-y-2 px-3">{active.map(card)}</ul>
          )}
        </Section>

        {haunts.length > 0 && (
          <Section title={w('haunts')} plain={hint('haunts')}>
            <ul className="divide-y divide-neutral-200 px-3 dark:divide-neutral-800">
              {haunts.map((haunt) => (
                <li key={haunt.cwd} className="flex items-center gap-3 py-1.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{haunt.name}</span>
                    <span className="block truncate text-xs text-neutral-500" title={haunt.cwd}>
                      {haunt.cwd} · {haunt.count} {haunt.count === 1 ? w('quest') : w('quests')}
                    </span>
                  </span>
                  {onNewIn && (
                    <button
                      type="button"
                      aria-label={`${w('setOutHere')}: ${haunt.name}`}
                      title={hint('setOutHere')}
                      onClick={() => onNewIn(haunt.cwd)}
                      className="shrink-0 rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
                    >
                      {w('setOutHere')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </Section>
        )}

        <Folded title={w('chronicle')} plain={hint('chronicle')} count={history.length}>
          <input
            type="search"
            placeholder={`Search this ${w('kingdom')}`}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            className="mx-3 mb-2 w-[calc(100%-1.5rem)] rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-950"
          />
          {searching ? (
            <SearchResults query={query.trim()} hits={hits} onOpen={onOpenHit} />
          ) : (
            <SessionList sessions={history} selected={null} onSelect={onSelect} now={now} empty="Nothing here yet." />
          )}
        </Folded>

        {found.length > 0 && (
          <Folded title={w('recruits')} plain={hint('recruits')} count={found.length}>
            <FoundSessions
              name={kingdom.name}
              sessions={found}
              connected={kingdom.connected}
              engines={engines}
              onAdopt={onAdopt}
              now={now}
            />
          </Folded>
        )}
      </div>
    </div>
  );
}
