import type { Deed, DeedsPage, Envelope } from '@crystal-bridge/protocol';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { refusal, UNREACHABLE } from './api.js';
import { readPref, subscribePrefs, writePref } from './devicePrefs.js';
import type { HubClient } from './hub.js';
import { type ErrandTone, errandTone } from './errands.js';
import { startOfDay } from './home.js';
import { projectName } from './quests.js';
import { hint, type QuestStanding, w, type Word } from './theme/words.js';
import type { IconName } from './theme/icons.js';

/** A Kingdom's Deeds feed (docs/DEEDS.md) as far as it has been read. */
export interface DeedsState {
  /** Rows of the loaded days, newest first. */
  deeds: Deed[];
  /** The newest window has arrived, so an empty list means none. */
  loaded: boolean;
  /** Why the feed couldn't be read, while none has arrived; the socket coming back reads it again. */
  error?: string;
  /** The time of the newest row before the loaded days; absent when there is none. */
  older?: number;
  /** Where the loaded days begin (epoch ms, a local midnight). */
  after?: number;
  loadingOlder?: boolean;
  /** A reconnect is reading the newest days again over the loaded ones; older days wait for it. */
  reloading?: boolean;
}

/** How many local days one page of the feed spans. */
export const PAGE_DAYS = 7;

const NONE: DeedsState = { deeds: [], loaded: false };
/** A safety stop for following `more`, far above what a Kingdom's days hold. */
const MAX_FOLLOWS = 200;

/** Local midnight `days` before the local day of `at`; `setDate` keeps a clock change from skewing it. */
function midnightBefore(at: number, days: number): number {
  const day = new Date(startOfDay(at));
  day.setDate(day.getDate() - days);
  return day.getTime();
}

const newestFirst = (a: Deed, b: Deed) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

function merge(first: readonly Deed[], second: readonly Deed[]): Deed[] {
  const byId = new Map<string, Deed>();
  for (const row of second) byId.set(row.id, row);
  for (const row of first) byId.set(row.id, row);
  return [...byId.values()].sort(newestFirst);
}

/** Reads one window, following `more` until the window is whole. */
async function readWindow(
  node: string,
  window: { after: number; before?: number },
  project: string | undefined,
  stale: () => boolean,
): Promise<DeedsPage & { deeds: Deed[] }> {
  let rows: Deed[] = [];
  let more: DeedsPage['more'];
  for (let follow = 0; follow <= MAX_FOLLOWS; follow += 1) {
    const query = [`after=${window.after}`];
    if (window.before !== undefined) query.push(`before=${window.before}`);
    if (project !== undefined) query.push(`project=${encodeURIComponent(project)}`);
    if (more) query.push(`beforeAt=${more.at}`, `beforeId=${encodeURIComponent(more.id)}`);
    let response: Response;
    try {
      response = await fetch(`/api/nodes/${encodeURIComponent(node)}/deeds?${query.join('&')}`);
    } catch {
      throw new Error(UNREACHABLE);
    }
    if (!response.ok) throw await refusal(response);
    const page = (await response.json()) as DeedsPage;
    rows = rows.concat(page.deeds ?? []);
    if (!page.more || stale()) return { deeds: rows, ...(page.older !== undefined ? { older: page.older } : {}) };
    more = page.more;
  }
  return { deeds: rows };
}

/**
 * A Kingdom's Deeds feed: the last 7 local days, then its frames, and `loadOlder` for the 7 days before what is
 * loaded. A frame that lands while a read is on its way is newer than it, so its rows win. Frames aren't replayed, so
 * a reconnect reads the newest days again. A frame with `cleared` drops every row. With a `project`, only that
 * project's rows are read and kept.
 */
export function useDeeds(
  hub: HubClient,
  node: string | undefined,
  project?: string,
): DeedsState & { loadOlder(): void } {
  const [state, setState] = useState<DeedsState>(NONE);
  const known = useRef(state);
  known.current = state;
  const older = useRef<() => void>(() => {});
  useEffect(() => {
    setState(NONE);
    known.current = NONE;
    if (!node) {
      older.current = () => {};
      return;
    }
    let latest = 0;
    let heard = new Map<string, Deed>();
    // Where the window being read begins, so a frame landing before the read is done keeps to it as well.
    let reading: number | undefined;
    const keeps = (row: Deed) => project === undefined || row.project === project;
    const load = () => {
      latest += 1;
      const round = latest;
      heard = new Map();
      const after = midnightBefore(Date.now(), PAGE_DAYS - 1);
      reading = after;
      // An older-days read still on its way is stale now: let go of it. Over loaded days, say a read is under way.
      setState((s) =>
        s.loaded || s.loadingOlder ? { ...s, loadingOlder: false, ...(s.loaded ? { reloading: true } : {}) } : s,
      );
      const fresh = () => round === latest;
      readWindow(node, { after }, project, () => !fresh())
        .then((page) => {
          if (!fresh()) return;
          reading = undefined;
          setState(() => ({
            deeds: merge([...heard.values()], page.deeds),
            loaded: true,
            after,
            ...(page.older !== undefined ? { older: page.older } : {}),
          }));
        })
        .catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          if (!fresh()) return;
          reading = undefined;
          setState((current) =>
            current.loaded ? { ...current, reloading: false } : { deeds: [], loaded: false, error: reason },
          );
        });
    };
    older.current = () => {
      const current = known.current;
      if (!current.loaded || current.older === undefined || current.after === undefined || current.loadingOlder) return;
      // Not while the newest days are read again: what that read brings replaces the window.
      if (reading !== undefined) return;
      const round = latest;
      const before = current.after;
      const after = midnightBefore(current.older, PAGE_DAYS - 1);
      setState((s) => ({ ...s, loadingOlder: true }));
      readWindow(node, { after, before }, project, () => round !== latest)
        .then((page) => {
          if (round !== latest) return;
          setState((s) => {
            const { older: _spent, error: _cleared, ...rest } = s;
            return {
              ...rest,
              deeds: merge(s.deeds, page.deeds),
              after,
              loadingOlder: false,
              ...(page.older !== undefined ? { older: page.older } : {}),
            };
          });
        })
        .catch((error: unknown) => {
          if (round !== latest) return;
          const reason = error instanceof Error ? error.message : String(error);
          setState((s) => ({ ...s, loadingOlder: false, error: reason }));
        });
    };
    load();
    const stopFrames = hub.onDeeds((frame) => {
      if (frame.node !== node) return;
      if (frame.cleared) {
        // The Kingdom was forgotten: what a read still on its way brings is stale too.
        latest += 1;
        heard = new Map();
        reading = undefined;
        setState({ deeds: [], loaded: true });
        return;
      }
      setState((current) => {
        const after = current.after ?? reading;
        const rows = frame.deeds.filter(
          (row) => keeps(row) && (after === undefined || row.at >= after || current.deeds.some((d) => d.id === row.id)),
        );
        for (const row of rows) heard.set(row.id, row);
        if (rows.length === 0) return current;
        return { ...current, deeds: merge(rows, current.deeds) };
      });
    });
    const stopReconnect = hub.onReconnect(load);
    return () => {
      latest += 1;
      stopFrames();
      stopReconnect();
    };
  }, [hub, node, project]);
  const loadOlder = useCallback(() => older.current(), []);
  return { ...state, loadOlder };
}

const CLOSE_DEEDS_KEY = 'crystal-bridge.close-deeds';

const readCloseDeeds = (): boolean => readPref(CLOSE_DEEDS_KEY) !== 'off';
const setCloseDeeds = (on: boolean): void => writePref(CLOSE_DEEDS_KEY, on ? 'on' : 'off');

/** Whether the Close dialog offers the summary call by default on this device, and a way to change it. */
export function useCloseDeeds(): [boolean, (on: boolean) => void] {
  return [useSyncExternalStore(subscribePrefs, readCloseDeeds), setCloseDeeds];
}

/** Whether a Quest has a finished turn since its latest call at Close (or ever, if it has had none). */
export function finishedTurnSinceClosing(envelopes: readonly Envelope[]): boolean {
  for (let i = envelopes.length - 1; i >= 0; i -= 1) {
    const type = envelopes[i]!.type;
    if (type === 'turn.finished') return true;
    if (type === 'deeds.closing') return false;
  }
  return false;
}

export interface DeedTotals {
  turns: number;
  /** Absent when no turn of the entry reported a tally: no counts is not zero. */
  files?: number;
  prs: string[];
  costUsd: number;
  durationMs: number;
}

export type DeedEntry =
  | {
      kind: 'quest';
      key: string;
      session: string;
      at: number;
      project?: string;
      patrol?: string;
      /** The Deeds the Quest wrote, in turns and at Close (a `closing` row is from Close), newest first. */
      deeds: Deed[];
      /** The turn records, newest first. */
      turns: Deed[];
      close?: Deed;
      totals: DeedTotals;
      latestReply?: string;
    }
  | { kind: 'run'; key: string; at: number; row: Deed };

export interface DeedDay {
  day: number;
  label: string;
  entries: DeedEntry[];
}

/** "Today", "Yesterday", else the date in the browser's format (with the year when it isn't this one). */
export function dayLabel(day: number, now: number): string {
  if (day === startOfDay(now)) return 'Today';
  if (day === midnightBefore(now, 1)) return 'Yesterday';
  const sameYear = new Date(day).getFullYear() === new Date(now).getFullYear();
  return new Date(day).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

function foldQuest(day: number, session: string, rows: Deed[]): DeedEntry {
  const turns = rows.filter((r) => r.kind === 'turn');
  const prs = new Set<string>();
  let files: number | undefined;
  let costUsd = 0;
  let durationMs = 0;
  for (const turn of turns) {
    if (turn.files !== undefined) files = (files ?? 0) + turn.files;
    for (const pr of turn.prs ?? []) prs.add(pr);
    costUsd += turn.costUsd ?? 0;
    durationMs += turn.durationMs ?? 0;
  }
  const close = rows.find((r) => r.kind === 'close');
  costUsd += close?.costUsd ?? 0;
  const first = rows[0]!;
  const project = rows.find((r) => r.project !== undefined)?.project;
  const patrol = rows.find((r) => r.patrol !== undefined)?.patrol;
  const latestReply = turns.find((t) => t.text)?.text;
  return {
    kind: 'quest',
    key: `${session}:${day}`,
    session,
    at: first.at,
    ...(project !== undefined ? { project } : {}),
    ...(patrol !== undefined ? { patrol } : {}),
    deeds: rows.filter((r) => r.kind === 'deed' || r.kind === 'closing'),
    turns,
    ...(close ? { close } : {}),
    totals: {
      turns: turns.length,
      ...(files !== undefined ? { files } : {}),
      prs: [...prs],
      costUsd: Math.round(costUsd * 1e6) / 1e6,
      durationMs,
    },
    ...(latestReply ? { latestReply } : {}),
  };
}

/**
 * The feed's rows folded into local days, newest first (a day with no rows is left out); on each day, one entry per
 * Quest and one per script run, newest first. The call at Close counts on the day it ran.
 */
export function deedDays(rows: readonly Deed[], now: number): DeedDay[] {
  const byDay = new Map<number, Deed[]>();
  for (const row of [...rows].sort(newestFirst)) {
    const day = startOfDay(row.at);
    const list = byDay.get(day);
    if (list) list.push(row);
    else byDay.set(day, [row]);
  }
  return [...byDay.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([day, dayRows]) => {
      const quests = new Map<string, Deed[]>();
      const entries: DeedEntry[] = [];
      for (const row of dayRows) {
        if (row.kind === 'patrol' || !row.session) {
          entries.push({ kind: 'run', key: row.id, at: row.at, row });
          continue;
        }
        const list = quests.get(row.session);
        if (list) list.push(row);
        else quests.set(row.session, [row]);
      }
      for (const [session, list] of quests) entries.push(foldQuest(day, session, list));
      entries.sort((a, b) => b.at - a.at);
      return { day, label: dayLabel(day, now), entries };
    });
}

const CLOSED_WHY = new Set(['writing', 'timeout', 'budget', 'empty', 'failed', 'unreadable']);

/** A Quest's standing from the session list and its latest call-at-Close row; a Quest the list lacks is closed. */
export function questStanding(session: { status: string } | undefined, close: Deed | undefined): QuestStanding {
  if (session && session.status !== 'closed') return { kind: 'open' };
  if (close?.outcome === 'recorded') return { kind: 'deeds' };
  const why = close?.outcome;
  if (why && CLOSED_WHY.has(why))
    return { kind: 'closed', why: why as Extract<QuestStanding, { kind: 'closed' }>['why'] };
  return { kind: 'closed', why: 'skipped' };
}

/** Each project in the rows once, with how many entries it has, the most used first; script runs have none. */
export function deedProjects(
  rows: readonly Deed[],
): { project: string; name: string; tone: ErrandTone; count: number }[] {
  const counts = new Map<string, number>();
  for (const day of deedDays(rows, 0)) {
    for (const entry of day.entries) {
      if (entry.kind === 'quest' && entry.project) counts.set(entry.project, (counts.get(entry.project) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([project, count]) => ({ project, name: projectName(project), tone: errandTone(project), count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

const STONE = 'bg-stone-200 text-stone-700 ring-stone-300 dark:bg-stone-800 dark:text-stone-200 dark:ring-stone-600';
const RED = 'bg-red-100 text-red-700 ring-red-300 dark:bg-red-950 dark:text-red-300 dark:ring-red-800';

const both = (themed: string, plain: string): Word => ({ themed, plain });

/** The icon, tile classes and label of an entry's rail marker: amber for Deeds, stone for a Patrol, red for a failed run. */
export function railLook(entry: DeedEntry): { icon: IconName; tile: string; label: Word } {
  const patrol = w('patrol');
  if (entry.kind === 'run') {
    const failed = entry.row.outcome === 'failed';
    return {
      icon: 'errandPatrol',
      tile: failed ? RED : STONE,
      label: both(
        `${patrol} · script${failed ? ' · failed' : ''}`,
        `${hint('patrol')} · script${failed ? ' · failed' : ''}`,
      ),
    };
  }
  if (entry.patrol) {
    return {
      icon: 'errandPatrol',
      tile: STONE,
      label: both(`${patrol}’s ${w('quest')}`, `${hint('patrol')}’s ${hint('quest')}`),
    };
  }
  if (entry.deeds.some((d) => d.kind === 'closing')) {
    return {
      icon: 'deedClosing',
      tile: 'bg-amber-100 text-amber-700 ring-amber-300 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-700',
      label: both('Summed up at close', 'Summed up at close'),
    };
  }
  if (entry.deeds.length > 0) {
    return {
      icon: 'quillInk',
      tile: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:ring-amber-800',
      label: both(`Recorded by the ${w('quest')}`, `Recorded by the ${hint('quest')}`),
    };
  }
  return {
    icon: 'deedTurns',
    tile: 'bg-neutral-100 text-neutral-600 ring-neutral-300 dark:bg-neutral-900 dark:text-neutral-300 dark:ring-neutral-700',
    label: both('Turn records only', 'Turn records only'),
  };
}
