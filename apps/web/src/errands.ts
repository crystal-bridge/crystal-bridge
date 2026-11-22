import type { Errand, ErrandCreate, ErrandEdit, ErrandState } from '@crystal-bridge/protocol';
import { useEffect, useState } from 'react';
import { refusal, UNREACHABLE } from './api.js';
import type { HubClient } from './hub.js';

/** A Kingdom's Errands (docs/ERRANDS.md) as the hub lists them. */
export interface ErrandsState {
  errands: Errand[];
  /** The hub's list has arrived, so an empty one means none. */
  loaded: boolean;
}

const NONE: ErrandsState = { errands: [], loaded: false };

const errandsPath = (node: string) => `/api/nodes/${encodeURIComponent(node)}/errands`;
const errandPath = (node: string, id: string) => `${errandsPath(node)}/${encodeURIComponent(id)}`;

/**
 * A Kingdom's Errands: the hub's list, then its frames. A frame that lands while the list is on its way is newer than
 * it, so it wins. Frames aren't replayed, so the list is read again when the socket comes back.
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
      void fetch(errandsPath(node))
        .then((response) => (response.ok ? (response.json() as Promise<{ errands?: Errand[] }>) : undefined))
        .then((loaded) => {
          if (!loaded || round !== latest || heardList) return;
          setState({ errands: loaded.errands ?? [], loaded: true });
        })
        .catch(() => {});
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
