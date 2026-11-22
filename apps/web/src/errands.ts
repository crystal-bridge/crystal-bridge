import type { Errand, ErrandCreate, ErrandEdit, ErrandState, ListedPatrol } from '@crystal-bridge/protocol';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { refusal, UNREACHABLE } from './api.js';
import { readPref, subscribePrefs, writePref } from './devicePrefs.js';
import type { HubClient } from './hub.js';
import { projectName } from './quests.js';
import { SENDER_TONES, type SenderTone } from './theme/boardTones.js';
import { questLabel, w } from './theme/words.js';

/** A Kingdom's Errands (docs/ERRANDS.md) as the hub lists them. */
export interface ErrandsState {
  errands: Errand[];
  /** The hub's list has arrived, so an empty one means none. */
  loaded: boolean;
  /** Why the list couldn't be read, while none has arrived; the socket coming back reads it again. */
  error?: string;
}

const NONE: ErrandsState = { errands: [], loaded: false };

const errandsPath = (node: string) => `/api/nodes/${encodeURIComponent(node)}/errands`;
const errandPath = (node: string, id: string) => `${errandsPath(node)}/${encodeURIComponent(id)}`;

/**
 * A Kingdom's Errands: the hub's list, then its frames. A frame that lands while the list is on its way is newer than
 * it, so it wins. Frames aren't replayed, so the list is read again when the socket comes back. A list that fails
 * leaves the state unloaded with the reason (`error`), until the socket comes back and it's read again.
 */
export function useErrands(hub: HubClient, node: string | undefined): ErrandsState {
  const [state, setState] = useState<ErrandsState>(NONE);
  useEffect(() => {
    setState(NONE);
    if (!node) return;
    let latest = 0;
    let heardList = false;
    const load = () => {
      latest += 1;
      const round = latest;
      heardList = false;
      const fresh = () => round === latest && !heardList;
      void fetch(errandsPath(node))
        .then(
          async (response) => {
            if (!response.ok) throw await refusal(response);
            return (await response.json()) as { errands?: Errand[] };
          },
          () => {
            throw new Error(UNREACHABLE);
          },
        )
        .then((loaded) => {
          if (fresh()) setState({ errands: loaded.errands ?? [], loaded: true });
        })
        .catch((error: unknown) => {
          // Stays unloaded, so the panel can say why; a list already shown stays shown.
          const reason = error instanceof Error ? error.message : String(error);
          if (fresh()) setState((known) => (known.loaded ? known : { errands: [], loaded: false, error: reason }));
        });
    };
    load();
    const stopFrames = hub.onErrands((frame) => {
      if (frame.node !== node) return;
      heardList = true;
      setState({ errands: frame.errands, loaded: true });
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

/** How many Errands each Kingdom has open: the hub's counts, then each frame's open ones. */
export function useErrandCounts(hub: HubClient): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    let latest = 0;
    // Kingdoms a frame has spoken for since the read began; the frame is newer, so it wins.
    let heard = new Set<string>();
    const load = () => {
      latest += 1;
      const round = latest;
      heard = new Set();
      void fetch('/api/errands/counts')
        .then((response) => (response.ok ? (response.json() as Promise<Record<string, number>>) : undefined))
        .then((loaded) => {
          if (!loaded || round !== latest) return;
          setCounts((known) => {
            const next: Record<string, number> = {};
            for (const [node, count] of Object.entries(loaded)) if (count > 0 && !heard.has(node)) next[node] = count;
            for (const node of heard) if (known[node]) next[node] = known[node];
            return next;
          });
        })
        .catch(() => {});
    };
    load();
    const stopFrames = hub.onErrands((frame) => {
      heard.add(frame.node);
      const open = frame.errands.filter((errand) => errand.state === 'open').length;
      setCounts((known) => {
        const { [frame.node]: _gone, ...rest } = known;
        return open > 0 ? { ...rest, [frame.node]: open } : rest;
      });
    });
    const stopReconnect = hub.onReconnect(load);
    return () => {
      latest += 1;
      stopFrames();
      stopReconnect();
    };
  }, [hub]);
  return counts;
}

async function send(url: string, method: 'POST' | 'PUT', body: unknown): Promise<Errand> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(UNREACHABLE);
  }
  if (!response.ok) throw await refusal(response);
  const { errand } = (await response.json()) as { errand?: Errand };
  if (!errand) throw new Error('the hub sent no Errand');
  return errand;
}

/** Adds an Errand by hand; a refusal says why (a full list, a bad folder). */
export function addErrand(node: string, draft: ErrandCreate): Promise<Errand> {
  return send(errandsPath(node), 'POST', draft);
}

/** Changes an Errand's title and body. */
export function editErrand(node: string, id: string, edit: ErrandEdit): Promise<Errand> {
  return send(errandPath(node, id), 'PUT', edit);
}

/** Ticks an Errand done, dismisses it, or opens it again. */
export function setErrandState(node: string, id: string, state: ErrandState): Promise<Errand> {
  return send(`${errandPath(node, id)}/state`, 'PUT', { state });
}

/** The colours an Errand's project can take: a Board's sender colours, less the blues, which only mean "needs you". */
const PROJECT_TONES = SENDER_TONES.filter((tone) => tone !== 'blue' && tone !== 'sky') as Exclude<
  SenderTone,
  'blue' | 'sky'
>[];
export type ErrandTone = (typeof PROJECT_TONES)[number] | 'slate';

/** The classes for each tone, written out whole so the stylesheet build keeps them. */
export const ERRAND_TONES: Record<
  ErrandTone,
  { bar: string; dot: string; wash: string; text: string; chip: string; stripe: string }
> = {
  rose: {
    bar: 'bg-rose-400 dark:bg-rose-500',
    dot: 'bg-rose-500',
    wash: 'from-rose-100 dark:from-rose-950',
    text: 'text-rose-700 dark:text-rose-300',
    chip: 'bg-rose-100 text-rose-900 ring-rose-300 dark:bg-rose-950 dark:text-rose-200 dark:ring-rose-800',
    stripe: 'border-l-rose-400 dark:border-l-rose-500',
  },
  orange: {
    bar: 'bg-orange-400 dark:bg-orange-500',
    dot: 'bg-orange-500',
    wash: 'from-orange-100 dark:from-orange-950',
    text: 'text-orange-700 dark:text-orange-300',
    chip: 'bg-orange-100 text-orange-900 ring-orange-300 dark:bg-orange-950 dark:text-orange-200 dark:ring-orange-800',
    stripe: 'border-l-orange-400 dark:border-l-orange-500',
  },
  amber: {
    bar: 'bg-amber-400 dark:bg-amber-500',
    dot: 'bg-amber-500',
    wash: 'from-amber-100 dark:from-amber-950',
    text: 'text-amber-700 dark:text-amber-300',
    chip: 'bg-amber-100 text-amber-900 ring-amber-300 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-800',
    stripe: 'border-l-amber-400 dark:border-l-amber-500',
  },
  lime: {
    bar: 'bg-lime-400 dark:bg-lime-500',
    dot: 'bg-lime-500',
    wash: 'from-lime-100 dark:from-lime-950',
    text: 'text-lime-700 dark:text-lime-300',
    chip: 'bg-lime-100 text-lime-900 ring-lime-300 dark:bg-lime-950 dark:text-lime-200 dark:ring-lime-800',
    stripe: 'border-l-lime-400 dark:border-l-lime-500',
  },
  emerald: {
    bar: 'bg-emerald-400 dark:bg-emerald-500',
    dot: 'bg-emerald-500',
    wash: 'from-emerald-100 dark:from-emerald-950',
    text: 'text-emerald-700 dark:text-emerald-300',
    chip: 'bg-emerald-100 text-emerald-900 ring-emerald-300 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-800',
    stripe: 'border-l-emerald-400 dark:border-l-emerald-500',
  },
  teal: {
    bar: 'bg-teal-400 dark:bg-teal-500',
    dot: 'bg-teal-500',
    wash: 'from-teal-100 dark:from-teal-950',
    text: 'text-teal-700 dark:text-teal-300',
    chip: 'bg-teal-100 text-teal-900 ring-teal-300 dark:bg-teal-950 dark:text-teal-200 dark:ring-teal-800',
    stripe: 'border-l-teal-400 dark:border-l-teal-500',
  },
  violet: {
    bar: 'bg-violet-400 dark:bg-violet-500',
    dot: 'bg-violet-500',
    wash: 'from-violet-100 dark:from-violet-950',
    text: 'text-violet-700 dark:text-violet-300',
    chip: 'bg-violet-100 text-violet-900 ring-violet-300 dark:bg-violet-950 dark:text-violet-200 dark:ring-violet-800',
    stripe: 'border-l-violet-400 dark:border-l-violet-500',
  },
  fuchsia: {
    bar: 'bg-fuchsia-400 dark:bg-fuchsia-500',
    dot: 'bg-fuchsia-500',
    wash: 'from-fuchsia-100 dark:from-fuchsia-950',
    text: 'text-fuchsia-700 dark:text-fuchsia-300',
    chip: 'bg-fuchsia-100 text-fuchsia-900 ring-fuchsia-300 dark:bg-fuchsia-950 dark:text-fuchsia-200 dark:ring-fuchsia-800',
    stripe: 'border-l-fuchsia-400 dark:border-l-fuchsia-500',
  },
  slate: {
    bar: 'bg-neutral-300 dark:bg-neutral-600',
    dot: 'bg-neutral-400',
    wash: 'from-neutral-100 dark:from-neutral-900',
    text: 'text-neutral-600 dark:text-neutral-300',
    chip: 'bg-neutral-100 text-neutral-800 ring-neutral-300 dark:bg-neutral-900 dark:text-neutral-200 dark:ring-neutral-700',
    stripe: 'border-l-neutral-300 dark:border-l-neutral-600',
  },
};

/** A project's colour, stable for its folder (hashed as a sender's colour is, so it may differ from its Board colour). */
export function errandTone(project: string | undefined): ErrandTone {
  if (!project) return 'slate';
  let hash = 0x811c9dc5;
  for (const char of project.trim().toLowerCase()) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // FNV-1a's low bits follow only the low bits of each character, so nearby paths would share a colour: mix first.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x45d9f3b) >>> 0;
  hash = (hash ^ (hash >>> 16)) >>> 0;
  return PROJECT_TONES[hash % PROJECT_TONES.length]!;
}

export const openOnes = (errands: readonly Errand[]): Errand[] => errands.filter((e) => e.state === 'open');

/** Done and dismissed Errands, the latest to close first. */
export const closedOnes = (errands: readonly Errand[]): Errand[] =>
  errands.filter((e) => e.state !== 'open').sort((a, b) => (b.closed ?? b.updated) - (a.closed ?? a.updated));

export interface ProjectGroup {
  project: string | undefined;
  name: string;
  tone: ErrandTone;
  errands: Errand[];
  /** This project's part of the open Errands, 0 to 1; all groups sum to 1. */
  share: number;
}

/** Open Errands by project, the project with the newest Errand first and no project last; each newest first. */
export function projectGroups(open: readonly Errand[]): ProjectGroup[] {
  const by = new Map<string | undefined, Errand[]>();
  for (const errand of [...open].sort((a, b) => b.created - a.created)) {
    const list = by.get(errand.project);
    if (list) list.push(errand);
    else by.set(errand.project, [errand]);
  }
  const groups = [...by].map(([project, errands]) => ({
    project,
    name: project === undefined ? 'No project' : projectName(project),
    tone: errandTone(project),
    errands,
    share: errands.length / open.length,
  }));
  return [...groups.filter((g) => g.project !== undefined), ...groups.filter((g) => g.project === undefined)];
}

export type ErrandDay = 'today' | 'yesterday' | 'earlier';

/** Open Errands by the local day they were made, newest first, leaving out days with none. */
export function dayGroups(open: readonly Errand[], now: number): { day: ErrandDay; errands: Errand[] }[] {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const today = midnight.getTime();
  midnight.setDate(midnight.getDate() - 1);
  const yesterday = midnight.getTime();
  const days: Record<ErrandDay, Errand[]> = { today: [], yesterday: [], earlier: [] };
  for (const errand of [...open].sort((a, b) => b.created - a.created)) {
    days[errand.created >= today ? 'today' : errand.created >= yesterday ? 'yesterday' : 'earlier'].push(errand);
  }
  return (['today', 'yesterday', 'earlier'] as const)
    .filter((day) => days[day].length > 0)
    .map((day) => ({ day, errands: days[day] }));
}

export type ErrandSource =
  | { kind: 'quest'; session: string; label: string }
  | { kind: 'patrol'; session: string; name: string }
  | { kind: 'hand' };

/** Where an Errand came from: a Quest (still linked if the list lacks it), a Patrol's Quest, or you. */
export function errandSource(
  errand: Errand,
  known: {
    sessions: readonly { id: string; label: string; plainLabel?: string | undefined }[];
    patrols: readonly ListedPatrol[];
  },
): ErrandSource {
  const { session } = errand;
  if (session === undefined) return { kind: 'hand' };
  if (errand.patrol !== undefined) {
    const patrol = known.patrols.find((p) => p.id === errand.patrol);
    return { kind: 'patrol', session, name: patrol?.manifest?.name ?? errand.patrol };
  }
  const quest = known.sessions.find((s) => s.id === session);
  return { kind: 'quest', session, label: quest ? questLabel(quest) : w('quest') };
}

export type ErrandLayout = 'checklist' | 'cards';

const LAYOUT_KEY = 'crystal-bridge.errands-layout';

function readLayout(): ErrandLayout {
  return readPref(LAYOUT_KEY) === 'cards' ? 'cards' : 'checklist';
}

const setLayout = (layout: ErrandLayout): void => writePref(LAYOUT_KEY, layout);

/** Whether Errands show as a checklist by project or as cards by day on this device, and a way to change it. */
export function useErrandLayout(): [ErrandLayout, (layout: ErrandLayout) => void] {
  return [useSyncExternalStore(subscribePrefs, readLayout), setLayout];
}

/** How many Errands each Quest left, in any state; hand-made ones (no session) aren't counted. */
export function errandsBySession(errands: readonly Errand[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const errand of errands) {
    if (errand.session) counts[errand.session] = (counts[errand.session] ?? 0) + 1;
  }
  return counts;
}
