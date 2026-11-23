import {
  type Deed,
  DeedRecordedPayload,
  DeedsClosingPayload,
  type Envelope,
  type ListedPatrol,
} from '@crystal-bridge/protocol';
import { type ReactNode, useEffect, useMemo, useRef } from 'react';
import {
  type DeedEntry,
  deedDays,
  deedProjects,
  type DeedsState,
  type DeedTotals,
  questStanding,
  railLook,
} from '../deeds.js';
import { ERRAND_TONES, type ErrandTone, errandTone } from '../errands.js';
import { duration, money } from '../format.js';
import { projectName } from '../quests.js';
import { Icon, type IconName } from '../theme/icons.js';
import {
  closingLine,
  deedsEmptyLines,
  deedsText,
  feedText,
  hint,
  type QuestStanding,
  questLabel,
  questStandingWord,
  w,
  words,
} from '../theme/words.js';
import type { SessionSummary } from './SessionList.js';

export interface DeedsFeedProps {
  /** The Kingdom's feed as `useDeeds` reads it. */
  state: DeedsState;
  /** The Kingdom's Quests, to name each entry's Quest and tell whether it is still open. */
  sessions: readonly SessionSummary[];
  /** The Kingdom's Patrols, to name the one behind a Quest or a script run. */
  patrols: readonly ListedPatrol[];
  /** The project the feed is filtered by; absent for all. */
  project?: string | undefined;
  /** This device's name for the Kingdom, for the empty feed's card. */
  kingdom?: string;
  now?: number;
  /** The phone's form: the same entries, chips and links, with no unfolding. */
  phone?: boolean;
  onProject: (project: string | undefined) => void;
  /** Opens an entry's Quest, closed or not. */
  onOpenQuest: (session: string) => void;
  /** Opens a script Patrol's run in its log. */
  onOpenRun: (patrol: string, run: string) => void;
  onLoadOlder: () => void;
  /**
   * The project chips seen unfiltered, kept by the caller per Kingdom so they outlive this copy (a phone's copy
   * remounts) and never carry over to another Kingdom; absent, the feed keeps its own.
   */
  chipMemory?: { current: ChipMemory };
}

type ProjectCount = ReturnType<typeof deedProjects>[number];

/** The chips' projects and counts as last seen unfiltered. */
export interface ChipMemory {
  all: number;
  projects: ProjectCount[];
}

/** A fresh, empty chip memory for one Kingdom's feed. */
export const newChipMemory = (): { current: ChipMemory } => ({ current: { all: 0, projects: [] } });

interface Known {
  sessions: readonly SessionSummary[];
  patrols: readonly ListedPatrol[];
  /** Each Quest's latest call-at-Close row among the loaded rows, whatever day it landed on. */
  closes: Map<string, Deed>;
  phone: boolean;
  onOpenQuest: (session: string) => void;
  onOpenRun: (patrol: string, run: string) => void;
}

const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * A Kingdom's Deeds on the Castle (docs/DEEDS.md, Read the annals): days newest first down a gold rail, one entry per
 * Quest's day and per script run, a chip per project to filter by. Gold for Deeds, never window blue.
 */
export function DeedsFeed({
  state,
  sessions,
  patrols,
  project,
  kingdom,
  now = Date.now(),
  phone = false,
  onProject,
  onOpenQuest,
  onOpenRun,
  onLoadOlder,
  chipMemory,
}: DeedsFeedProps) {
  const feed = w('deedsFeed');
  const text = feedText();
  const rows = project === undefined ? state.deeds : state.deeds.filter((row) => row.project === project);
  const days = deedDays(rows, now);
  const closes = new Map<string, Deed>();
  for (const row of state.deeds) {
    if (row.kind === 'close' && row.session && !closes.has(row.session)) closes.set(row.session, row);
  }
  const known: Known = { sessions, patrols, closes, phone, onOpenQuest, onOpenRun };
  const chips = useChips(state.deeds, project, chipMemory);
  return (
    <section aria-label={feed} className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 px-3">
        <span
          aria-hidden="true"
          className="grid size-7 place-items-center rounded-md bg-amber-100 text-amber-700 ring-1 ring-amber-300 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-700"
        >
          <Icon name="deedsFeed" size={20} />
        </span>
        <h2 className="cb-display text-2xl leading-none" title={hint('deedsFeed')}>
          {feed}
        </h2>
        {!phone && <span className="text-xs text-neutral-500">{capitalised(words.deedsFeed.plain)}</span>}
      </div>
      {state.error !== undefined && !state.loaded ? (
        <p role="alert" className="px-3 text-sm text-red-700 dark:text-red-400">
          {text.readFailed(state.error)}
        </p>
      ) : !state.loaded ? (
        <p className="px-3 text-sm text-neutral-500">{text.reading}</p>
      ) : (
        <>
          {/* At the top: what shows below may be out of date. */}
          {state.refreshError !== undefined && (
            <p role="alert" className="px-3 text-sm text-red-700 dark:text-red-400">
              {text.rereadFailed(state.refreshError)}
            </p>
          )}
          {chips.projects.length > 0 && (
            <div className="px-3">
              <Chips chips={chips} project={project} phone={phone} onProject={onProject} />
            </div>
          )}
          {days.length === 0 ? (
            <Empty project={project} kingdom={kingdom} onProject={onProject} />
          ) : phone ? (
            <div>
              {days.map((day) => (
                <div key={day.day}>
                  <h3 className="cb-display bg-neutral-50 px-3 py-1 text-lg leading-none text-amber-800 dark:bg-neutral-900 dark:text-amber-300">
                    {day.label}
                  </h3>
                  <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
                    {day.entries.map((entry) => (
                      <Entry key={entry.key} entry={entry} known={known} />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-3">
              <div className="relative">
                <span
                  data-rail
                  aria-hidden="true"
                  className="absolute bottom-2 left-[1.2rem] top-2 w-0.5 rounded bg-linear-to-b from-amber-300 via-neutral-200 to-transparent dark:from-amber-700 dark:via-neutral-800"
                />
                {days.map((day) => (
                  <div key={day.day}>
                    <div className="relative mb-1 flex items-center gap-2 pb-2 pt-1">
                      <span
                        aria-hidden="true"
                        className="relative z-10 ml-2 grid size-5 place-items-center rounded-full bg-amber-400 ring-4 ring-white dark:bg-amber-500 dark:ring-neutral-950"
                      >
                        <span className="size-1.5 rounded-full bg-white" />
                      </span>
                      <h3 className="cb-display ml-3 text-xl leading-none text-amber-800 dark:text-amber-300">
                        {day.label}
                      </h3>
                      <span aria-hidden="true" className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
                    </div>
                    <ul className="relative">
                      {day.entries.map((entry) => (
                        <Entry key={entry.key} entry={entry} known={known} />
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          )}
          {state.error !== undefined && (
            <p role="alert" className="px-3 text-sm text-red-700 dark:text-red-400">
              {text.olderFailed(state.error)}
            </p>
          )}
          {state.older !== undefined && (
            <LoadOlder
              loading={state.loadingOlder === true || state.reloading === true}
              failed={state.error !== undefined}
              read={state.read?.n ?? 0}
              newest={state.read?.newest === true}
              onLoadOlder={onLoadOlder}
            />
          )}
        </>
      )}
    </section>
  );
}

/**
 * The chips' projects and counts. A filtered read holds only its project's rows, so the projects seen unfiltered stay
 * listed while a filter is on.
 */
function useChips(
  rows: readonly Deed[],
  project: string | undefined,
  memory: { current: ChipMemory } | undefined,
): ChipMemory {
  const own = useRef<ChipMemory>({ all: 0, projects: [] });
  const seen = memory ?? own;
  const listed = deedProjects(rows);
  const all = deedDays(rows, 0).reduce((sum, day) => sum + day.entries.length, 0);
  if (project === undefined) {
    seen.current = { all, projects: listed };
    return seen.current;
  }
  const projects = seen.current.projects.map((p) => listed.find((l) => l.project === p.project) ?? p);
  for (const l of listed) if (!projects.some((p) => p.project === l.project)) projects.push(l);
  if (!projects.some((p) => p.project === project)) {
    projects.push({ project, name: projectName(project), tone: errandTone(project), count: 0 });
  }
  return { all: Math.max(seen.current.all, all), projects };
}

const CHIP =
  'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-bold ring-1';

function Chips({
  chips,
  project,
  phone,
  onProject,
}: {
  chips: { all: number; projects: ProjectCount[] };
  project: string | undefined;
  phone: boolean;
  onProject: (project: string | undefined) => void;
}) {
  return (
    <div
      role="group"
      aria-label={feedText().filter}
      className={`flex items-center gap-1.5 ${phone ? 'overflow-x-auto' : 'flex-wrap'}`}
    >
      <span aria-hidden="true" title={feedText().filter} className="inline-flex text-neutral-400">
        <Icon name="deedFilter" size={14} />
      </span>
      <button
        type="button"
        aria-pressed={project === undefined}
        onClick={() => onProject(undefined)}
        className={`${CHIP} ${
          project === undefined
            ? 'bg-neutral-800 text-white ring-neutral-800 dark:bg-neutral-200 dark:text-neutral-900 dark:ring-neutral-200'
            : 'bg-white text-neutral-700 ring-neutral-300 dark:bg-neutral-950 dark:text-neutral-300 dark:ring-neutral-700'
        }`}
      >
        {feedText().all}
        <span className="opacity-70">{chips.all}</span>
      </button>
      {chips.projects.map((chip) => {
        const on = chip.project === project;
        const tone = ERRAND_TONES[chip.tone];
        return (
          <button
            key={chip.project}
            type="button"
            aria-pressed={on}
            title={chip.project}
            onClick={() => onProject(on ? undefined : chip.project)}
            className={`${CHIP} ${on ? tone.on : tone.chip}`}
          >
            <span
              aria-hidden="true"
              className={`size-2 rounded-full ${on ? 'bg-white/90 dark:bg-neutral-950/70' : tone.dot}`}
            />
            {chip.name}
            <span className="opacity-70">{chip.count}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The empty feed: a card with the open book, and with a project chosen, a way back to them all. */
function Empty({
  project,
  kingdom,
  onProject,
}: {
  project: string | undefined;
  kingdom: string | undefined;
  onProject: (project: string | undefined) => void;
}) {
  const place = project !== undefined ? projectName(project) : kingdom;
  const lines = deedsEmptyLines(place, project !== undefined);
  return (
    <div
      data-empty
      className="mx-3 flex flex-col items-center gap-2 rounded-lg border border-dashed border-amber-300 px-4 py-8 text-center dark:border-amber-800"
    >
      <span
        aria-hidden="true"
        className="grid size-12 place-items-center rounded-full bg-amber-50 text-amber-500 dark:bg-amber-950 dark:text-amber-400"
      >
        <Icon name="openBook" size={28} />
      </span>
      <p className="cb-display text-xl leading-none">{lines.title}</p>
      <p className="max-w-sm text-sm text-neutral-500 dark:text-neutral-400">{lines.line}</p>
      {project !== undefined && (
        <button type="button" onClick={() => onProject(undefined)} className="text-xs font-bold underline">
          {lines.showAll}
        </button>
      )}
    </div>
  );
}

/** How many pages the feed's end, staying in view, may load in a row before the button waits for the user. */
const AUTO_PAGES = 3;

/**
 * Load older days: a button, and the same when the feed's end scrolls into view where the browser can tell. Held while
 * a read is under way. After a page arrives the end is looked at again (an observer reports at once, then only on a
 * change), so a short feed fills itself, but only `AUTO_PAGES` in a row until the user scrolls or clicks. Only a read
 * that succeeded lets the end, already in view, ask again: after a failed one (of older days, or of the newest after a
 * reconnect) only the button or a scroll does, since the end being in view would otherwise ask over and over.
 */
function LoadOlder({
  loading,
  failed,
  read,
  newest,
  onLoadOlder,
}: {
  loading: boolean;
  failed: boolean;
  /** How many reads have succeeded: a new one since the observer last looked is what lets it ask by itself. */
  read: number;
  /** The latest successful read was of the newest days (a reconnect cut the feed back): the count of pages starts over. */
  newest: boolean;
  onLoadOlder: () => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  const load = useRef(onLoadOlder);
  load.current = onLoadOlder;
  // Pages loaded in a row with no scroll or click from the user.
  const auto = useRef(0);
  // The successful reads an observer has reported after; none yet when it mounts. Marked on the report, not when the
  // effect runs: one torn down before its report (StrictMode runs effects twice) mustn't use the read up.
  const looked = useRef<number | undefined>(undefined);
  useEffect(() => {
    const element = end.current;
    if (loading || failed || !element || typeof IntersectionObserver === 'undefined') return;
    let first = true;
    const observer = new IntersectionObserver((entries) => {
      const seen = entries.some((e) => e.isIntersecting);
      if (!first) {
        // The end came into view: the user scrolled.
        if (!seen) return;
        auto.current = 0;
        load.current();
        return;
      }
      first = false;
      const fresh = looked.current !== read;
      looked.current = read;
      if (fresh && newest) auto.current = 0;
      if (seen && fresh && auto.current < AUTO_PAGES) {
        auto.current += 1;
        load.current();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [loading, failed, read, newest]);
  const click = () => {
    auto.current = 0;
    onLoadOlder();
  };
  return (
    <div ref={end} className="px-3">
      <button
        type="button"
        disabled={loading}
        onClick={click}
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-bold text-amber-800 ring-1 ring-amber-300 hover:bg-amber-50 disabled:opacity-60 dark:text-amber-300 dark:ring-amber-800 dark:hover:bg-amber-950"
      >
        <Icon name="hourglass" size={14} />
        {feedText().loadOlder}
      </button>
    </div>
  );
}

const clock = (at: number) => {
  const time = new Date(at);
  return `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
};

/** 42m, 1h 05m: a day's working time as the feed shows it; under a minute in seconds. */
function spent(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`;
}

/** A pull request link as `#319`, else the link itself. */
const prLabel = (link: string) => {
  const number = /\/(\d+)\/?$/.exec(link)?.[1];
  return number ? `#${number}` : link;
};

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** The stat icons keep one colour each. */
const STAT: Record<'turns' | 'files' | 'prs' | 'cost' | 'time', { icon: IconName; tone: string; title: string }> = {
  turns: { icon: 'deedTurns', tone: 'text-neutral-500 dark:text-neutral-400', title: hint('turns') },
  files: { icon: 'deedLoot', tone: 'text-orange-700 dark:text-orange-400', title: hint('loot') },
  prs: { icon: 'deedTrophy', tone: 'text-yellow-600 dark:text-yellow-400', title: hint('prs') },
  cost: { icon: 'gold', tone: 'text-amber-600 dark:text-amber-400', title: hint('gold') },
  time: { icon: 'hourglass', tone: 'text-stone-500 dark:text-stone-400', title: hint('workingTime') },
};

/** "4 turns · 12 files · PR #319 · $1.84 · 42m", each with its icon; no files count where no turn reported one. */
function StatLine({ totals, turns = true, small = false }: { totals: DeedTotals; turns?: boolean; small?: boolean }) {
  const parts: [keyof typeof STAT, string][] = [];
  if (turns) parts.push(['turns', plural(totals.turns, 'turn')]);
  if (totals.files !== undefined) parts.push(['files', plural(totals.files, 'file')]);
  if (totals.prs.length > 0) parts.push(['prs', `PR ${totals.prs.map(prLabel).join(' ')}`]);
  parts.push(['cost', money(totals.costUsd)]);
  parts.push(['time', spent(totals.durationMs)]);
  return (
    <span
      className={`inline-flex flex-wrap items-center gap-y-0.5 ${small ? 'text-[11px]' : 'text-xs'} text-neutral-600 dark:text-neutral-400`}
    >
      {parts.map(([kind, text], i) => (
        <span key={kind} className="inline-flex items-center">
          {i > 0 && (
            <span aria-hidden="true" className="px-1 text-neutral-300 dark:text-neutral-700">
              {' · '}
            </span>
          )}
          <span className="inline-flex items-center gap-1 whitespace-nowrap" title={STAT[kind].title}>
            <span aria-hidden="true" className={`inline-flex ${STAT[kind].tone}`}>
              <Icon name={STAT[kind].icon} size={14} />
            </span>
            {text}
          </span>
        </span>
      ))}
    </span>
  );
}

const STANDING: Record<QuestStanding['kind'], { icon: IconName; chip: string }> = {
  open: {
    icon: 'deedOpen',
    chip: 'bg-emerald-50 text-emerald-800 ring-emerald-300 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-800',
  },
  deeds: {
    icon: 'markSealCheck',
    chip: 'bg-amber-100 text-amber-900 ring-amber-300 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-700',
  },
  closed: {
    icon: 'markFlag',
    chip: 'bg-neutral-100 text-neutral-700 ring-neutral-300 dark:bg-neutral-900 dark:text-neutral-300 dark:ring-neutral-700',
  },
};

const PILL = 'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[11px] font-bold ring-1';

function StandingChip({ standing }: { standing: QuestStanding }) {
  const look = STANDING[standing.kind];
  const word = questStandingWord(standing);
  return (
    <span title={word.plain} className={`${PILL} ${look.chip}`}>
      <Icon name={look.icon} size={12} />
      {word.themed}
    </span>
  );
}

function ProjectChip({ project }: { project: string }) {
  const tone = ERRAND_TONES[errandTone(project)];
  return (
    <span
      title={project}
      className={`inline-flex min-w-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-bold ring-1 ${tone.chip}`}
    >
      <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${tone.dot}`} />
      <span className="truncate">{projectName(project)}</span>
    </span>
  );
}

function OpenLink({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="inline-flex items-center gap-0.5 whitespace-nowrap text-[11px] font-bold text-neutral-500 underline-offset-2 hover:underline dark:text-neutral-400"
    >
      <Icon name="deedLink" size={12} />
      {label}
    </button>
  );
}

function PatrolName({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-neutral-500 dark:text-neutral-400">
      <Icon name="errandPatrol" size={14} />
      {`${w('patrol')}: ${name}`}
    </span>
  );
}

const patrolName = (patrols: readonly ListedPatrol[], id: string) =>
  patrols.find((p) => p.id === id)?.manifest?.name ?? id;

/** No browser marker on a fold's summary: the caret stands in for it. */
const SUMMARY = 'cursor-pointer list-none [&::-webkit-details-marker]:hidden';

function Caret() {
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 text-neutral-400 transition-transform group-open/fold:rotate-90 dark:text-neutral-500"
    >
      <Icon name="caret" size={10} />
    </span>
  );
}

/**
 * An entry's faint wash in its project's colour: pale in light mode, deep and dim in dark, so the rows read as a list
 * with a coloured edge rather than as banners. Written out whole so the stylesheet build keeps them.
 */
const ENTRY_WASH: Record<ErrandTone, string> = {
  rose: 'from-rose-50 dark:from-rose-950/60',
  orange: 'from-orange-50 dark:from-orange-950/60',
  amber: 'from-amber-50 dark:from-amber-950/60',
  lime: 'from-lime-50 dark:from-lime-950/60',
  emerald: 'from-emerald-50 dark:from-emerald-950/60',
  teal: 'from-teal-50 dark:from-teal-950/60',
  violet: 'from-violet-50 dark:from-violet-950/60',
  fuchsia: 'from-fuchsia-50 dark:from-fuchsia-950/60',
  slate: 'from-neutral-50 dark:from-neutral-900/60',
};

/** One entry: its tile on the rail (or at the row's start on a phone), then its lines in its project's colour. */
function Entry({ entry, known }: { entry: DeedEntry; known: Known }) {
  const look = railLook(entry);
  const project = entry.kind === 'run' ? undefined : entry.project;
  const toneName = errandTone(project);
  const tone = ERRAND_TONES[toneName];
  const name = entry.kind === 'run' ? (entry.row.text ?? look.label.themed) : questName(entry.session, known);
  const tile = (size: string, icon: number) => (
    <span
      data-rail-tile
      title={look.label.themed}
      className={`grid shrink-0 place-items-center rounded-full ${size} ${look.tile}`}
    >
      <Icon name={look.icon} size={icon} />
    </span>
  );
  const body =
    entry.kind === 'run' ? <RunLines entry={entry} known={known} /> : <QuestLines entry={entry} known={known} />;
  if (known.phone) {
    return (
      <li data-entry aria-label={name} className={`flex gap-2.5 border-l-4 ${tone.stripe} px-2.5 py-2`}>
        <span className="mt-0.5">{tile('size-7 ring-1', 16)}</span>
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 flex items-center gap-2 text-[11px] text-neutral-500 dark:text-neutral-400">
            <span className="font-mono">{clock(entry.at)}</span>
          </div>
          {body}
        </div>
      </li>
    );
  }
  return (
    <li data-entry aria-label={name} className="relative pb-3 pl-12">
      <span className="absolute left-1 top-0">{tile('size-8 ring-2', 18)}</span>
      <div
        className={`rounded-md border-l-4 ${tone.stripe} bg-linear-to-r ${ENTRY_WASH[toneName]} to-transparent to-50% py-1 pl-3 pr-2`}
      >
        <div className="mb-0.5 flex items-center gap-2 text-[11px] text-neutral-500 dark:text-neutral-400">
          <span className="font-mono">{clock(entry.at)}</span>
          <span title={look.label.plain}>{look.label.themed}</span>
        </div>
        {body}
      </div>
    </li>
  );
}

function questName(session: string, known: Known): string {
  const quest = known.sessions.find((s) => s.id === session);
  return quest ? questLabel(quest) : w('quest');
}

function RunLines({ entry, known }: { entry: Extract<DeedEntry, { kind: 'run' }>; known: Known }) {
  const { row } = entry;
  const failed = row.outcome === 'failed';
  const runId = row.id.replace(/^run:/, '');
  return (
    <>
      <p className="font-medium leading-snug [overflow-wrap:anywhere]">{row.text ?? feedText().scriptRun}</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-500">
        <span
          className={`${PILL} ${
            failed
              ? 'bg-red-100 text-red-800 ring-red-300 dark:bg-red-950 dark:text-red-200 dark:ring-red-800'
              : 'bg-emerald-100 text-emerald-800 ring-emerald-300 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-800'
          }`}
        >
          <Icon name={failed ? 'markXCircle' : 'markIssueClosed'} size={12} />
          {failed ? 'Failed' : 'Ran'}
        </span>
        {row.patrol && <PatrolName name={patrolName(known.patrols, row.patrol)} />}
        <span>{row.durationMs !== undefined ? `script · ${duration(row.durationMs)}` : 'script'}</span>
        {row.patrol && (
          <OpenLink
            label={feedText().runLog}
            title={feedText().openRunTitle}
            onClick={() => known.onOpenRun(row.patrol!, runId)}
          />
        )}
      </div>
    </>
  );
}

function QuestLines({ entry, known }: { entry: Extract<DeedEntry, { kind: 'quest' }>; known: Known }) {
  const quest = known.sessions.find((s) => s.id === entry.session);
  const title = questName(entry.session, known);
  const standing = questStanding(quest, known.closes.get(entry.session));
  const fold = !known.phone && entry.turns.length > 0;
  const patrol = entry.patrol !== undefined && <PatrolName name={patrolName(known.patrols, entry.patrol)} />;
  const links = (
    <>
      {entry.project !== undefined && <ProjectChip project={entry.project} />}
      <OpenLink
        label={feedText().openQuest}
        title={feedText().openQuestTitle}
        onClick={() => known.onOpenQuest(entry.session)}
      />
    </>
  );
  if (entry.deeds.length > 0) {
    const line = (
      <>
        <span className="text-[13px] font-medium text-neutral-700 dark:text-neutral-300">{title}</span>
        <StandingChip standing={standing} />
        <StatLine totals={entry.totals} />
      </>
    );
    return (
      <>
        <ul className="space-y-0.5">
          {entry.deeds.map((deed) => (
            <DeedLine key={deed.id} deed={deed} />
          ))}
        </ul>
        {fold ? (
          <details className="group/fold mt-1">
            <summary
              className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded px-0.5 py-0.5 hover:bg-neutral-50 dark:hover:bg-neutral-900 ${SUMMARY}`}
            >
              <Caret />
              {line}
            </summary>
            <TurnList turns={entry.turns} />
          </details>
        ) : (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 px-0.5">{line}</div>
        )}
        <div className="mt-0.5 flex flex-wrap items-center gap-2 pl-4">
          {patrol}
          {links}
        </div>
      </>
    );
  }
  const head = (
    <>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {fold && <Caret />}
        <span className="font-bold [overflow-wrap:anywhere]">{title}</span>
        <StatLine totals={entry.totals} />
      </span>
      {entry.latestReply && (
        <span
          className={`mt-0.5 block truncate text-[13px] text-neutral-600 dark:text-neutral-400 ${fold ? 'pl-4 group-open/fold:hidden' : ''}`}
        >
          {`“${entry.latestReply}”`}
        </span>
      )}
    </>
  );
  return (
    <>
      {fold ? (
        <details className="group/fold">
          <summary className={`block rounded px-0.5 py-0.5 hover:bg-neutral-50 dark:hover:bg-neutral-900 ${SUMMARY}`}>
            {head}
          </summary>
          <TurnList turns={entry.turns} />
        </details>
      ) : (
        <div className="px-0.5 py-0.5">{head}</div>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-2 pl-4">
        <StandingChip standing={standing} />
        {patrol}
        {links}
      </div>
    </>
  );
}

/** A Deed as a line: laurels for one written at Close, the quill for one a turn recorded; its detail beneath. */
function DeedLine({ deed }: { deed: Deed }) {
  const closing = deed.kind === 'closing';
  return (
    <li data-deed className="leading-snug">
      <span className="flex items-start gap-2 font-bold">
        <span
          title={closing ? deedsText().fromClose : deedsText().fromTurn}
          className="mt-0.5 inline-flex text-amber-600 dark:text-amber-400"
        >
          <Icon name={closing ? 'deedClosing' : 'quillInk'} size={16} />
        </span>
        <span data-deed-text className="[overflow-wrap:anywhere]">
          {deed.text ?? ''}
        </span>
      </span>
      {deed.detail && (
        <p className="pl-6 text-[13px] font-normal text-neutral-600 [overflow-wrap:anywhere] dark:text-neutral-400">
          {deed.detail}
        </p>
      )}
    </li>
  );
}

/** A Quest's turn records for the day: time, totals and the start of the reply, newest first. */
function TurnList({ turns }: { turns: Deed[] }): ReactNode {
  return (
    <ol className="ml-1 mt-1.5 space-y-1 border-l-2 border-dashed border-neutral-200 dark:border-neutral-800">
      {turns.map((turn, i) => (
        <li key={turn.id} className="ml-2 rounded-md px-2 py-1 hover:bg-neutral-50 dark:hover:bg-neutral-900">
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="font-mono font-bold text-neutral-500">{clock(turn.at)}</span>
            <span className="text-neutral-400">{`turn ${turns.length - i}`}</span>
            <span className="flex-1" />
            <StatLine
              small
              turns={false}
              totals={{
                turns: 1,
                ...(turn.files !== undefined ? { files: turn.files } : {}),
                prs: turn.prs ?? [],
                costUsd: turn.costUsd ?? 0,
                durationMs: turn.durationMs ?? 0,
              }}
            />
          </div>
          {turn.text && (
            <p className="text-[13px] leading-snug text-neutral-600 [overflow-wrap:anywhere] dark:text-neutral-400">
              {turn.text}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

/** A Quest's Deeds and its latest call at Close, read from its events. */
function questDeeds(envelopes: readonly Envelope[]): { deeds: Deed[]; closing?: DeedsClosingPayload } {
  const deeds: Deed[] = [];
  let closing: DeedsClosingPayload | undefined;
  for (const e of envelopes) {
    if (e.type === 'deed.recorded') {
      const parsed = DeedRecordedPayload.safeParse(e.payload);
      if (!parsed.success) continue;
      const { id, deed, detail, closing: fromClose } = parsed.data;
      deeds.push({
        id: `deed:${id}`,
        kind: fromClose ? 'closing' : 'deed',
        at: e.ts,
        text: deed,
        ...(detail !== undefined ? { detail } : {}),
      });
    } else if (e.type === 'deeds.closing') {
      const parsed = DeedsClosingPayload.safeParse(e.payload);
      if (parsed.success) closing = parsed.data;
    }
  }
  return { deeds, ...(closing ? { closing } : {}) };
}

/**
 * One Quest's Deeds, in its side panel, read from the Quest's own events (so it works for a Quest on any Kingdom): the
 * ones it recorded in turns and the ones the call at Close wrote, in the order they came, Close's marked with laurels.
 * Amber, as the Deeds are everywhere, never the window blue. Without any it says so, and why the call at Close wrote none.
 */
export function QuestDeeds({ envelopes }: { envelopes: readonly Envelope[] }) {
  const { deeds, closing } = useMemo(() => questDeeds(envelopes), [envelopes]);
  const why = closing && closing.outcome !== 'recorded' && closing.outcome !== 'writing' ? closing : undefined;
  return (
    <section
      aria-label={w('deeds')}
      className="rounded-lg border border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/40"
    >
      <div className="flex items-center gap-2 px-2.5 pt-2">
        <span aria-hidden="true" className="text-amber-700 dark:text-amber-300">
          <Icon name="deedClosing" size={18} />
        </span>
        <h3 className="cb-display text-xl leading-none" title={hint('deeds')}>
          {w('deeds')}
        </h3>
      </div>
      <ul className="mt-1.5 space-y-1.5 px-2.5 pb-2 text-sm">
        {deeds.length === 0 ? (
          <li className="text-xs text-neutral-500">{deedsText().none}</li>
        ) : (
          deeds.map((deed) => <DeedLine key={deed.id} deed={deed} />)
        )}
      </ul>
      {why && <p className="px-2.5 pb-2 text-xs text-neutral-500">{closingLine(why.outcome).themed}</p>}
    </section>
  );
}
