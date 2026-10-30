import { type CSSProperties, useState } from 'react';
import type { HeroManifest, HeroState } from '../heroes.js';
import type { Level } from '../levels.js';
import { type ActivityItem, activityLine, sumStats, type TurnStats } from '../home.js';
import { ago, QuestCard, StatTiles } from './HomeParts.js';
import type { KingdomLook } from '../appearance.js';
import type { Kingdom } from '../kingdoms.js';
import { hint, w } from '../theme/words.js';
import type { NotifyLevel } from '../notify.js';
import { isActiveQuest } from '../quests.js';
import { KingdomIcon } from './KingdomIcon.js';
import { Roster } from './Roster.js';
import { NodeUsage, type NodeUsageRow } from './NodeUsage.js';
import type { SessionSummary } from './SessionList.js';

export interface AirshipProps {
  /** The Kingdoms this device shows; hidden ones never reach the Airship. */
  kingdoms: Kingdom[];
  sessions: SessionSummary[];
  /** Quests waiting on the user: session id -> node. */
  waiting: Record<string, string>;
  usage: NodeUsageRow[];
  /** This device's notification level per Kingdom; Discreet ones show no Quest titles here. */
  notify: Record<string, NotifyLevel>;
  onKingdom: (id: string) => void;
  onQuest: (node: string, session: string) => void;
  /** Each Kingdom's icon and colour on this device. */
  looks?: Record<string, KingdomLook>;
  /** Every node's finished turns since local midnight; only the Kingdoms shown here are added up. */
  today?: TurnStats[];
  /** Recent Quest starts, closes and finished turns across all nodes, newest first. */
  activity?: ActivityItem[];
  heroes?: HeroManifest | null;
  heroStates?: Record<string, HeroState>;
  /** Each Hero Class's level, for the Roster (#23). */
  levels?: Record<string, Level>;
  /** Starts a New Quest on that Kingdom. */
  onNewQuest?: (node: string) => void;
  now?: number;
}

/** How many log lines show before "Show more". */
const LOG_SHOWN = 8;
/** How many active Quests a Kingdom card lists. */
const CARD_QUESTS = 3;

/**
 * The app-wide Home. The Tavern lists everything waiting on the user across the Kingdoms this device shows; a
 * Discreet Kingdom's entries name only the Kingdom. Below, a card per Kingdom opens its Castle.
 */
export function Airship({
  kingdoms,
  sessions,
  waiting,
  usage,
  notify,
  onKingdom,
  onQuest,
  looks = {},
  today = [],
  activity = [],
  heroes,
  heroStates = {},
  levels,
  onNewQuest,
  now = Date.now(),
}: AirshipProps) {
  const [moreLog, setMoreLog] = useState(false);
  const discreet = (node: string) => (notify[node] ?? 'full') === 'discreet';
  const shown = new Map(kingdoms.map((k) => [k.id, k]));
  const waitingIds = new Set(Object.keys(waiting));
  // Hidden Kingdoms never reach the Airship, not even as log lines.
  const log = activity.filter((item) => shown.has(item.node));
  const tavern = Object.entries(waiting)
    .filter(([, node]) => shown.has(node))
    .map(([session, node]) => {
      const kingdom = shown.get(node)!;
      const label = sessions.find((s) => s.id === session)?.label || `a ${w('quest')}`;
      const text =
        (notify[node] ?? 'full') === 'discreet'
          ? `${kingdom.name}: a ${w('quest')} needs you`
          : `${kingdom.name}: ${label}`;
      return { session, node, text };
    });

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 px-3 py-6">
        <h1 className="cb-display text-4xl leading-none" title={hint('home')}>
          {w('home')}
        </h1>

        <section aria-label={w('tavern')} className="cb-window space-y-2 p-4">
          <h2 className="cb-display text-2xl leading-none text-gold-bright" title={hint('tavern')}>
            {w('tavern')}
          </h2>
          {tavern.length === 0 ? (
            <p className="text-sm text-white/80">Nothing is waiting on you.</p>
          ) : (
            <ul className="space-y-1">
              {tavern.map((row) => (
                <li key={row.session}>
                  <button
                    type="button"
                    onClick={() => onQuest(row.node, row.session)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-white/10"
                  >
                    <span className="shrink-0 rounded-full bg-amber-500 px-1.5 text-xs font-bold leading-4 text-white">
                      !
                    </span>
                    <span className="truncate">{row.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <StatTiles title={w('today')} plain={hint('today')} stats={sumStats(today, new Set(shown.keys()))} />

        <section aria-label={w('kingdoms')} className="grid gap-3 sm:grid-cols-2">
          {kingdoms.map((kingdom) => {
            const own = sessions.filter((s) => s.node === kingdom.id);
            const active = own
              .filter((s) => isActiveQuest(s, now, waitingIds))
              .sort((a, b) => (b.lastActivity ?? b.createdAt) - (a.lastActivity ?? a.createdAt));
            const look = looks[kingdom.id];
            return (
              <div
                key={kingdom.id}
                data-kingdom={kingdom.id}
                style={look ? ({ '--kingdom-colour': look.colour } as CSSProperties) : undefined}
                className="flex flex-col gap-2 rounded-lg border border-l-4 border-neutral-300 border-l-[var(--kingdom-colour,var(--color-neutral-300))] bg-neutral-50 p-3 dark:border-neutral-700 dark:bg-neutral-900"
              >
                <button
                  type="button"
                  onClick={() => onKingdom(kingdom.id)}
                  title={`Open this ${w('kingdom')}: ${hint('castle')}`}
                  className="space-y-1 rounded px-1 text-left hover:bg-white dark:hover:bg-neutral-800"
                >
                  <span className="flex items-center gap-2">
                    {look && <KingdomIcon icon={look.icon} colour={look.colour} size={28} />}
                    <span className={`h-2 w-2 rounded-full ${kingdom.connected ? 'bg-green-500' : 'bg-neutral-400'}`} />
                    <span className="cb-display text-2xl leading-none">{kingdom.name}</span>
                  </span>
                  <span className="block text-sm text-neutral-500">
                    {kingdom.connected ? 'connected' : 'offline'} · {active.length} active
                  </span>
                </button>
                <div className="-mx-3">
                  <NodeUsage rows={usage.filter((row) => row.node === kingdom.id)} now={now} named={false} />
                </div>
                {active.length > 0 && (
                  <ul className="space-y-1.5">
                    {active.slice(0, CARD_QUESTS).map((session) => (
                      <li key={session.id}>
                        <QuestCard
                          session={session}
                          waiting={waitingIds.has(session.id)}
                          heroes={heroes}
                          state={heroStates[session.id]}
                          showDetail={!discreet(kingdom.id)}
                          now={now}
                          onOpen={() => onQuest(kingdom.id, session.id)}
                        />
                      </li>
                    ))}
                    {active.length > CARD_QUESTS && (
                      <li className="px-1 text-xs text-neutral-500">
                        and {active.length - CARD_QUESTS} more in its {w('castle')}
                      </li>
                    )}
                  </ul>
                )}
                {onNewQuest && (
                  <button
                    type="button"
                    onClick={() => onNewQuest(kingdom.id)}
                    aria-label={`${w('newQuest')} on ${kingdom.name}`}
                    title={hint('newQuest')}
                    className="self-start rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-white dark:border-neutral-700 dark:hover:bg-neutral-800"
                  >
                    + {w('newQuest')}
                  </button>
                )}
              </div>
            );
          })}
        </section>

        {heroes && levels && <Roster manifest={heroes} levels={levels} />}

        {log.length > 0 && (
          <section aria-label={w('adventureLog')} className="space-y-1">
            <h2 className="cb-display text-xl leading-none" title={hint('adventureLog')}>
              {w('adventureLog')}
            </h2>
            <ul className="divide-y divide-neutral-200 text-sm dark:divide-neutral-800">
              {(moreLog ? log : log.slice(0, LOG_SHOWN)).map((item) => (
                <li key={`${item.session}-${item.ts}-${item.kind}`} className="flex items-baseline gap-3 py-1">
                  <span className="w-10 shrink-0 text-right text-xs text-neutral-500">{ago(item.ts, now)}</span>
                  <span className="min-w-0 truncate">
                    {activityLine(item, shown.get(item.node)!.name, discreet(item.node))}
                  </span>
                </li>
              ))}
            </ul>
            {log.length > LOG_SHOWN && (
              <button
                type="button"
                onClick={() => setMoreLog((open) => !open)}
                className="text-xs text-neutral-500 hover:underline"
              >
                {moreLog ? 'Show less' : `Show ${log.length - LOG_SHOWN} more`}
              </button>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
