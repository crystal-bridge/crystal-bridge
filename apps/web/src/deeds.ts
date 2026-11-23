import type { Deed, DeedsPage, Envelope } from '@crystal-bridge/protocol';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { refusal, UNREACHABLE } from './api.js';
import { readPref, subscribePrefs, writePref } from './devicePrefs.js';
import type { HubClient } from './hub.js';
import { startOfDay } from './home.js';

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
    const keeps = (row: Deed) => project === undefined || row.project === project;
    const load = () => {
      latest += 1;
      const round = latest;
      heard = new Map();
      const after = midnightBefore(Date.now(), PAGE_DAYS - 1);
      const fresh = () => round === latest;
      readWindow(node, { after }, project, () => !fresh())
        .then((page) => {
          if (!fresh()) return;
          setState(() => ({
            deeds: merge([...heard.values()], page.deeds),
            loaded: true,
            after,
            ...(page.older !== undefined ? { older: page.older } : {}),
          }));
        })
        .catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          if (fresh()) setState((current) => (current.loaded ? current : { deeds: [], loaded: false, error: reason }));
        });
    };
    older.current = () => {
      const current = known.current;
      if (!current.loaded || current.older === undefined || current.after === undefined || current.loadingOlder) return;
      const round = latest;
      const before = current.after;
      const after = midnightBefore(current.older, PAGE_DAYS - 1);
      setState((s) => ({ ...s, loadingOlder: true }));
      readWindow(node, { after, before }, project, () => round !== latest)
        .then((page) => {
          if (round !== latest) return;
          setState((s) => {
            const { older: _spent, ...rest } = s;
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
        setState({ deeds: [], loaded: true });
        return;
      }
      setState((current) => {
        const rows = frame.deeds.filter(
          (row) =>
            keeps(row) &&
            (current.after === undefined || row.at >= current.after || current.deeds.some((d) => d.id === row.id)),
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
