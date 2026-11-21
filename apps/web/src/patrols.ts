import type {
  ListedPatrol,
  ListedPatrolRun,
  PatrolDraft,
  PatrolManifest,
  PatrolRun,
  Schedule,
} from '@crystal-bridge/protocol';
import { useEffect, useState } from 'react';
import { refusal, UNREACHABLE } from './api.js';
import type { HubClient } from './hub.js';

/** A Kingdom's Patrols (docs/PATROLS.md) as the Watchtower shows them, with each one's recent runs, newest first. */
export interface PatrolsState {
  patrols: ListedPatrol[];
  /** The Kingdom takes new and changed Patrols from the app right now. */
  editable: boolean;
  /** As the hub lists them: a run marked done on a Board says when. */
  runs: Record<string, ListedPatrolRun[]>;
  /** The hub's list has arrived, so an empty one means none. */
  loaded: boolean;
}

const NONE: PatrolsState = { patrols: [], editable: false, runs: {}, loaded: false };

const patrolsPath = (node: string) => `/api/nodes/${encodeURIComponent(node)}/patrols`;
const patrolPath = (node: string, patrol: string) => `${patrolsPath(node)}/${encodeURIComponent(patrol)}`;

/**
 * A Kingdom's Patrols and their runs: the hub's list, each Patrol's runs as it first appears, then the frames. A list
 * frame that lands while the list is on its way is newer than it, so it wins. Frames aren't replayed, so everything is
 * read again when the socket comes back.
 */
export function usePatrols(hub: HubClient, node: string | undefined): PatrolsState {
  const [state, setState] = useState<PatrolsState>(NONE);
  useEffect(() => {
    setState(NONE);
    if (!node) return;
    let latest = 0;
    let heardList = false;
    // Runs a frame gave while a Patrol's own read was on its way; the frame is newer, so it wins.
    let heardRuns = new Set<string>();
    let asked = new Set<string>();

    const readRuns = (patrols: readonly ListedPatrol[], round: number) => {
      for (const { id } of patrols) {
        if (asked.has(id)) continue;
        asked.add(id);
        // A read that fails is asked again when the list next comes; until then the card falls back on `lastRun`.
        const failed = () => {
          if (round === latest) asked.delete(id);
        };
        void fetch(patrolPath(node, id))
          .then((response) => (response.ok ? (response.json() as Promise<{ runs?: ListedPatrolRun[] }>) : undefined))
          .then((loaded) => {
            if (!loaded) return failed();
            if (round !== latest || heardRuns.has(id)) return;
            setState((known) => ({ ...known, runs: { ...known.runs, [id]: loaded.runs ?? [] } }));
          })
          .catch(failed);
      }
    };
    const load = () => {
      latest += 1;
      const round = latest;
      heardList = false;
      heardRuns = new Set();
      asked = new Set();
      void fetch(patrolsPath(node))
        .then((response) =>
          response.ok ? (response.json() as Promise<{ patrols?: ListedPatrol[]; editable?: boolean }>) : undefined,
        )
        .then((loaded) => {
          if (!loaded || round !== latest) return;
          if (!heardList) {
            const patrols = loaded.patrols ?? [];
            setState((known) => ({ ...known, patrols, editable: loaded.editable === true, loaded: true }));
            readRuns(patrols, round);
          }
        })
        .catch(() => {});
    };
    load();
    const stopFrames = hub.onPatrols((frame) => {
      if (frame.node !== node) return;
      if (frame.kind === 'patrols') {
        heardList = true;
        setState((known) => ({ ...known, patrols: frame.patrols, editable: frame.editable, loaded: true }));
        readRuns(frame.patrols, latest);
        return;
      }
      heardRuns.add(frame.patrol);
      setState((known) => ({ ...known, runs: { ...known.runs, [frame.patrol]: frame.runs } }));
    });
    const stopReconnect = hub.onReconnect(load);
    return () => {
      latest += 1;
      stopFrames();
      stopReconnect();
    };
  }, [hub, node]);
  return state;
}

/** How many reports a Board's Patrol log shows. */
export const BOARD_REPORTS = 12;

/** A run a Patrol posted to a Board, with the Patrol it's from. */
export interface BoardReport {
  patrol: ListedPatrol;
  run: ListedPatrolRun;
}

/**
 * The Patrols that post to a Scout's Board, and their reports newest first. A skip (the last run was still out) says
 * nothing new, so it's left out; a Patrol whose runs haven't loaded yet shows its latest.
 */
export function boardPatrols(
  state: Pick<PatrolsState, 'patrols' | 'runs'>,
  scout: string,
  limit = BOARD_REPORTS,
): { patrols: ListedPatrol[]; reports: BoardReport[] } {
  const patrols = state.patrols.filter((patrol) => patrol.manifest?.board === scout);
  const reports = patrols
    .flatMap((patrol) =>
      (state.runs[patrol.id] ?? (patrol.lastRun ? [patrol.lastRun] : [])).map((run) => ({ patrol, run })),
    )
    .filter(({ run }) => run.outcome !== 'skipped')
    .sort((a, b) => b.run.startedAt - a.run.startedAt)
    .slice(0, limit);
  return { patrols, reports };
}

/**
 * How a Patrol stands, for its card's colour and word: what stops it first (a file that never loaded, a stand-down),
 * then a run that's out or waiting on you, then recent failures.
 */
export type PatrolStanding = 'broken' | 'stood-down' | 'out' | 'waiting' | 'failing' | 'on-watch';

export function patrolStanding(patrol: ListedPatrol, runs: readonly PatrolRun[] | undefined): PatrolStanding {
  if (!patrol.manifest) return 'broken';
  if (patrol.paused) return 'stood-down';
  const latest = runs?.[0] ?? patrol.lastRun;
  if (latest?.outcome === 'running') return 'out';
  if (latest?.outcome === 'needs-you') return 'waiting';
  if ((patrol.failures ?? 0) > 0) return 'failing';
  return 'on-watch';
}

/** "in 20m", "in 4h 50m", "in 3d": how long until a Patrol's next run. */
export function untilText(at: number, now: number): string {
  if (at <= now) return 'due now';
  const minutes = Math.max(1, Math.round((at - now) / 60_000));
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  return `in ${Math.round(hours / 24)}d`;
}

export function browserZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** A run's time in a zone, as the Watchtower and the form show it: "Fri 20 Nov, 15:30". */
export function runTime(at: number, zone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: zone,
  }).format(at);
}

async function send(url: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown, signal?: AbortSignal) {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(UNREACHABLE);
  }
  if (!response.ok) throw await refusal(response);
  return response;
}

/** Asks the Kingdom to send a Patrol out now, outside its schedule. Its card updates when the run starts. */
export async function runPatrolNow(node: string, patrol: string): Promise<void> {
  await send(`${patrolPath(node, patrol)}/run`, 'POST');
}

/** Has the Kingdom draft a Quest Patrol from a Board item's Quest action ("Patrol this"); a refusal says why. */
export async function draftPatrol(node: string, scout: string, action: string, id: string): Promise<PatrolDraft> {
  const response = await send(
    `/api/nodes/${encodeURIComponent(node)}/scouts/${encodeURIComponent(scout)}/draft`,
    'POST',
    {
      action,
      id,
    },
  );
  return ((await response.json()) as { draft: PatrolDraft }).draft;
}

/** Marks a Patrol's run done on its Board, or not done again; every open Board hears the change. */
export async function markPatrolRun(node: string, patrol: string, run: string, done: boolean): Promise<void> {
  await send(`${patrolPath(node, patrol)}/runs/${encodeURIComponent(run)}/done`, 'POST', { done });
}

/** Stands a Patrol down, puts it back on its schedule, or deletes it (its Kingdom keeps the folder in `.deleted/`). */
export async function changePatrol(node: string, patrol: string, op: 'pause' | 'resume' | 'delete'): Promise<void> {
  await (op === 'delete'
    ? send(patrolPath(node, patrol), 'DELETE')
    : send(`${patrolPath(node, patrol)}/${op}`, 'POST'));
}

/**
 * Saves a Quest Patrol: its Kingdom checks it as it would a file, writes `patrol.json` and answers. The card updates when
 * the Kingdom reports its list again.
 */
export async function savePatrol(node: string, patrol: string, manifest: PatrolManifest): Promise<void> {
  await send(patrolPath(node, patrol), 'PUT', { manifest });
}

/** The next run times a schedule gives, worked out on its Kingdom; a refusal carries the Kingdom's reason. */
export async function previewPatrol(node: string, schedule: Schedule, signal: AbortSignal): Promise<number[]> {
  const response = await send(
    `/api/nodes/${encodeURIComponent(node)}/patrol-preview`,
    'POST',
    { schedule, count: 5 },
    signal,
  );
  const { times } = (await response.json()) as { times?: number[] };
  return Array.isArray(times) ? times : [];
}
