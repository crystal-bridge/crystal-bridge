import type { PatrolSeed } from '../patrolForm.js';
import { type CSSProperties, type ReactNode, useState } from 'react';
import type { KingdomLook } from '../appearance.js';
import { KingdomIcon } from './KingdomIcon.js';
import { hint, postingsLine, w } from '../theme/words.js';
import type {
  Engine,
  ExternalSession,
  ListedScout,
  PatrolManifest,
  Project,
  Schedule,
  SelfUpdate,
} from '@crystal-bridge/protocol';
import type { Kingdom } from '../kingdoms.js';
import type { PatrolsState } from '../patrols.js';
import { isActiveQuest, type UnseenQuest } from '../quests.js';
import type { Circle } from '../summons.js';
import { FoundSessions } from './FoundSessions.js';
import { NodeUsage, type NodeUsageRow } from './NodeUsage.js';
import { type SearchHit, SearchResults } from './SearchResults.js';
import { type SessionSummary, SessionList } from './SessionList.js';
import type { HeroManifest, HeroState } from '../heroes.js';
import { recentProjects, type TurnStats } from '../home.js';
import { isBehind, releaseLabel } from '../release.js';
import { Garrison, type GarrisonProps } from './Garrison.js';
import { Watchtower } from './Watchtower.js';
import { hasCircle, SummoningCircle } from './SummoningCircle.js';
import { Folded, HOME_PAGE, HOME_PAIR, QUEST_GRID, QuestCard, StatTiles } from './HomeParts.js';

export interface CastleProps {
  kingdom: Kingdom;
  /** This Kingdom's Quests, newest first. */
  sessions: SessionSummary[];
  waiting: ReadonlySet<string>;
  /** Finished Quests the user hasn't viewed since: they stay in play, marked, until opened. */
  unseen?: Record<string, UnseenQuest>;
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
  /** The Kingdom's Crystal release (a version, or its deployed commit), when it reports one. */
  release?: string;
  /** The hub's own release, to tell when this Kingdom is behind it. */
  hubRelease?: string;
  /** How this Kingdom's own move to the hub's release is going, when it updates itself. */
  selfUpdate?: SelfUpdate;
  /** The agent CLI version this Kingdom runs, and the latest published one when the hub checks. */
  cli?: string;
  latestCli?: string;
  /** Runs the CLI's own update on this Kingdom and resolves to its version; without it, no Update button. */
  onUpdateCli?: (id: string) => Promise<string | undefined>;
  /** Revokes this Kingdom's token and cuts its connection; without it, no Remove. */
  onRemove?: (id: string) => Promise<void>;
  /** Who fights here; without it, as in the plain theme, no Garrison. */
  garrison?: GarrisonProps | undefined;
  /** This Kingdom's Summons and their Casts. */
  circle?: Circle;
  /** This Kingdom's Scouts, each with a Board; without `onOpenBoard`, no Boards section. */
  scouts?: ListedScout[];
  onOpenBoard?: (scout: string) => void;
  /**
   * This Kingdom's Patrols and their runs, for the Watchtower. It shows once there is a Patrol, or on a wide screen
   * once one can be made: with `onSavePatrol` and `onPreviewPatrol`, on a Kingdom that takes Patrols from the app.
   */
  patrols?: PatrolsState;
  onRunPatrol?: (patrol: string) => Promise<void>;
  onChangePatrol?: (patrol: string, op: 'pause' | 'resume' | 'delete') => Promise<void>;
  onSavePatrol?: (patrol: string, manifest: PatrolManifest) => Promise<void>;
  onPreviewPatrol?: (schedule: Schedule, signal: AbortSignal) => Promise<number[]>;
  /** A Board item's draft ("Patrol this"): the Watchtower opens New Patrol from it, then lets it go. */
  patrolSeed?: PatrolSeed | undefined;
  onPatrolSeedUsed?: () => void;
  /** The Kingdom's projects, for the Patrol form's picker. */
  projects?: Project[];
  /** Boards with a pinned tab on this device; the others' cards offer Pin when `onPinBoard` is given. */
  pinnedBoards?: ReadonlySet<string>;
  onPinBoard?: (scout: string) => void;
  /** This Kingdom has no token and no connection: it can no longer be removed, only forgotten. */
  removed?: boolean;
  /** Deletes the hub's copy of a removed Kingdom's Quests. */
  onForget?: (id: string) => Promise<void>;
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

/** What a Board's card says under its name: what stops it first, else what's new on it. */
function boardNote(scout: ListedScout): { text: string; plain?: string; warn: boolean } {
  if (scout.error && !scout.manifest) return { text: "scout.json doesn't load", warn: true };
  if (scout.paused) return { text: 'Paused', plain: scout.paused, warn: true };
  if (scout.error) return { text: "scout.json doesn't load: its last good one runs", warn: true };
  if (scout.fresh > 0) {
    const line = postingsLine(scout.fresh, scout.manifest?.name ?? scout.id);
    return { text: line.themed, plain: line.plain, warn: false };
  }
  if (!scout.lastRun) return { text: 'No runs yet', warn: false };
  return { text: 'Nothing new', warn: false };
}

/** A card per Scout, opening its Board. */
function Boards({
  scouts,
  onOpen,
  pinned,
  onPin,
}: {
  scouts: ListedScout[];
  onOpen: (scout: string) => void;
  /** Boards pinned on this device; with `onPin`, every other card offers Pin. */
  pinned?: ReadonlySet<string> | undefined;
  onPin?: ((scout: string) => void) | undefined;
}) {
  return (
    <Section title={w('boards')} plain={hint('boards')}>
      <ul className={`${QUEST_GRID} px-3`}>
        {scouts.map((scout) => {
          const note = boardNote(scout);
          const name = scout.manifest?.name ?? scout.id;
          const pin = onPin && pinned && !pinned.has(scout.id) ? onPin : undefined;
          return (
            <li key={scout.id} className="flex items-stretch gap-1">
              <button
                type="button"
                onClick={() => onOpen(scout.id)}
                className="flex w-full items-center gap-3 rounded border border-neutral-300 px-3 py-2 text-left hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{name}</span>
                  <span
                    title={note.plain}
                    className={`block truncate text-xs ${note.warn ? 'text-amber-700 dark:text-amber-400' : 'text-neutral-500'}`}
                  >
                    {note.text}
                  </span>
                </span>
                {scout.fresh > 0 && (
                  <span className="shrink-0 rounded-full bg-amber-400 px-2 text-xs font-bold text-neutral-950">
                    {scout.fresh}
                  </span>
                )}
              </button>
              {pin && (
                <button
                  type="button"
                  aria-label={`Pin ${name} to tab strip`}
                  title="Give it a tab in the tab strip on this device"
                  onClick={() => pin(scout.id)}
                  className="shrink-0 rounded border border-neutral-300 px-2 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
                >
                  Pin
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/** Where a Kingdom's update of itself stands. It keeps running its version until the swap, so a failure costs nothing. */
function SelfUpdateLine({ update: { version, state, reason } }: { update: SelfUpdate }) {
  if (state === 'failed') {
    return (
      <p role="alert" className="whitespace-pre-wrap text-sm text-red-600 dark:text-red-400">
        Could not update to {version}, so it stays on its version and tries again later. {reason}
      </p>
    );
  }
  const words = {
    installing: `Updating to ${version}…`,
    waiting: `${version} is ready: this Kingdom restarts on it once no Quest here is busy.`,
    restarting: `Restarting on ${version}…`,
  };
  return (
    <p role="status" className="text-sm text-neutral-500">
      {words[state]}
    </p>
  );
}

/**
 * Updates the Kingdom's CLI. The Kingdom itself refuses while a Quest there is busy, and that reason shows here. It stays
 * mounted after the update catches up, so the outcome outlives the button.
 */
function UpdateCli({
  kingdom,
  cli,
  behind,
  onUpdateCli,
}: {
  kingdom: Kingdom;
  cli: string;
  behind: boolean;
  onUpdateCli: (id: string) => Promise<string | undefined>;
}) {
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function update(): Promise<void> {
    setRunning(true);
    setDone(null);
    setError(null);
    try {
      const version = await onUpdateCli(kingdom.id);
      if (!version) setDone('Update finished');
      else setDone(version === cli ? `Still on ${cli}` : `Updated to ${version}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setRunning(false);
    }
  }

  if (!behind && !done && !error) return null;
  return (
    <div className="mt-1 space-y-1 text-xs">
      {behind && (
        <button
          type="button"
          disabled={running}
          onClick={() => void update()}
          className="rounded border border-neutral-300 px-2 py-1 hover:bg-neutral-200 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          {running ? 'Updating…' : 'Update Claude Code'}
        </button>
      )}
      {done && (
        <p role="status" className="text-neutral-500">
          {done}
        </p>
      )}
      {error && (
        <p role="alert" className="whitespace-pre-wrap text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

/** Removing a Kingdom cuts it off at once, so it asks first. */
function RemoveKingdom({ kingdom, onRemove }: { kingdom: Kingdom; onRemove: (id: string) => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove(): Promise<void> {
    setError(null);
    try {
      await onRemove(kingdom.id);
      setConfirming(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  const button =
    'rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-200 dark:border-neutral-700 dark:hover:bg-neutral-800';
  return (
    <div className="space-y-2 px-3 pb-4 text-xs text-neutral-500">
      {!confirming && (
        <button type="button" onClick={() => setConfirming(true)} className={button}>
          {`Remove ${kingdom.name}`}
        </button>
      )}
      {confirming && (
        <>
          <p>{`This revokes its token and disconnects it now. Its ${w('quests')} stay in the ${w('chronicle')} until you forget them.`}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void remove()}
              className="rounded bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700"
            >
              Yes, remove
            </button>
            <button type="button" onClick={() => setConfirming(false)} className={button}>
              Keep it
            </button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

/** Forgetting can't be undone, so it asks for the Kingdom's name. */
function ForgetKingdom({ kingdom, onForget }: { kingdom: Kingdom; onForget: (id: string) => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function forget(): Promise<void> {
    setError(null);
    try {
      await onForget(kingdom.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  const button =
    'rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-200 dark:border-neutral-700 dark:hover:bg-neutral-800';
  return (
    <div className="space-y-2 px-3 pb-4 text-xs text-neutral-500">
      {!confirming && (
        <button type="button" onClick={() => setConfirming(true)} className={button}>
          {`Forget ${kingdom.name}`}
        </button>
      )}
      {confirming && (
        <>
          <p>
            {`This deletes its ${w('quests')} from the hub for good, and its tab goes with them. Their transcripts on the machine stay.`}
          </p>
          <input
            aria-label={`Type ${kingdom.name} to confirm`}
            placeholder={kingdom.name}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            className="cb-field block py-0.5"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={typed !== kingdom.name}
              onClick={() => void forget()}
              className="rounded bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              Yes, forget it
            </button>
            <button type="button" onClick={() => setConfirming(false)} className={button}>
              Keep it
            </button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A Kingdom's home: what needs the user, the Quests in play, and New Quest up front; the Chronicle (history and
 * search) and Recruits folded away. The header flies the Kingdom's banner: its icon and colour on this device.
 */
export function Castle({
  kingdom,
  circle,
  scouts = [],
  onOpenBoard,
  patrols,
  onRunPatrol,
  onChangePatrol,
  onSavePatrol,
  onPreviewPatrol,
  patrolSeed,
  onPatrolSeedUsed,
  projects,
  pinnedBoards,
  onPinBoard,
  sessions,
  waiting,
  unseen = {},
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
  hubRelease,
  selfUpdate,
  cli,
  latestCli,
  onUpdateCli,
  onRemove,
  removed,
  onForget,
  garrison,
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
        unseen={unseen[session.id]?.reason}
        heroes={heroes}
        state={heroStates[session.id]}
        now={now}
        onOpen={() => onSelect(session.id)}
      />
    </li>
  );
  const marked = new Set([...waiting, ...Object.keys(unseen)]);
  const needsYou = sessions.filter((s) => waiting.has(s.id));
  const active = sessions.filter((s) => !waiting.has(s.id) && isActiveQuest(s, now, marked));
  const history = sessions.filter((s) => !isActiveQuest(s, now, marked));
  const searching = query.trim().length >= 2;

  return (
    <div className="h-full overflow-y-auto">
      <div className={`${HOME_PAGE} space-y-5 py-6`}>
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
                {release && <span title="Crystal release"> · {releaseLabel(release)}</span>}
                {cli && (
                  <span title="agent CLI version">
                    {' '}
                    · Claude Code {cli}
                    {isBehind(cli, latestCli) && (
                      <span className="text-amber-700 dark:text-amber-400"> (update available: {latestCli})</span>
                    )}
                  </span>
                )}
                {engines && engines.length > 0 && (
                  <span title="engines this Kingdom runs"> · {engines.join(', ')}</span>
                )}
              </p>
              {selfUpdate ? (
                <SelfUpdateLine update={selfUpdate} />
              ) : (
                isBehind(release, hubRelease) && (
                  <p role="status" className="text-sm text-amber-700 dark:text-amber-400">
                    Behind the Airship ({hubRelease}): update this Kingdom.
                  </p>
                )
              )}
              {cli && kingdom.connected && onUpdateCli && (
                <UpdateCli
                  key={kingdom.id}
                  kingdom={kingdom}
                  cli={cli}
                  behind={isBehind(cli, latestCli)}
                  onUpdateCli={onUpdateCli}
                />
              )}
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

        <div className={HOME_PAIR}>
          <StatTiles title={w('today')} plain={hint('today')} stats={today} />
          <StatTiles title={w('thisWeek')} plain={hint('thisWeek')} stats={week} />
        </div>

        <div
          className={`grid items-start gap-5 ${haunts.length > 0 || garrison ? 'xl:grid-cols-[minmax(0,1fr)_24rem]' : ''}`}
        >
          <div className="min-w-0 space-y-5">
            {needsYou.length > 0 && (
              <Section title={w('needsYou')} plain={hint('needsYou')}>
                <ul className={`${QUEST_GRID} px-3`}>{needsYou.map(card)}</ul>
              </Section>
            )}

            <Section title={w('activeQuests')} plain={hint('activeQuests')}>
              {active.length === 0 ? (
                <p className="px-3 text-sm text-neutral-500">{`Nothing in play. Start one with ${w('newQuest')}.`}</p>
              ) : (
                <ul className={`${QUEST_GRID} px-3`}>{active.map(card)}</ul>
              )}
            </Section>

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
                <SessionList
                  sessions={history}
                  selected={null}
                  onSelect={onSelect}
                  now={now}
                  empty="Nothing here yet."
                />
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
          {(haunts.length > 0 || garrison) && (
            <div className="min-w-0 space-y-5">
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
              {garrison && (
                // Decoration: it stays off a phone, along with other new panels.
                <div className="hidden px-3 md:block">
                  <Garrison {...garrison} />
                </div>
              )}
            </div>
          )}
        </div>

        {onOpenBoard && scouts.length > 0 && (
          // A desktop panel for now, like the Summoning Circle below.
          <div className="hidden md:block">
            <Boards scouts={scouts} onOpen={onOpenBoard} pinned={pinnedBoards} onPin={onPinBoard} />
          </div>
        )}

        {patrols && (
          <>
            <div className="hidden md:block">
              <Watchtower
                state={patrols}
                now={now ?? Date.now()}
                onRun={onRunPatrol}
                onChange={onChangePatrol}
                onOpenQuest={onSelect}
                onSave={onSavePatrol}
                onPreview={onPreviewPatrol}
                seed={patrolSeed}
                onSeedUsed={onPatrolSeedUsed}
                projects={projects}
                engines={engines}
              />
            </div>
            {/* The phone shows Patrols read-only: its actions need their own design there. */}
            {patrols.patrols.length > 0 && (
              <div className="md:hidden">
                <Watchtower state={patrols} now={now ?? Date.now()} onOpenQuest={onSelect} />
              </div>
            )}
          </>
        )}

        {circle && hasCircle(circle.summons, circle.casts) && (
          // A desktop panel for now: a phone's actions need their own design.
          <div className="hidden px-3 md:block">
            <SummoningCircle
              summons={circle.summons}
              casts={circle.casts}
              now={now ?? Date.now()}
              kingdom={kingdom.name}
            />
          </div>
        )}

        {!removed && onRemove && <RemoveKingdom key={kingdom.id} kingdom={kingdom} onRemove={onRemove} />}
        {removed && onForget && <ForgetKingdom key={kingdom.id} kingdom={kingdom} onForget={onForget} />}
      </div>
    </div>
  );
}
