import { useEffect, useState } from 'react';
import type { Cast, Summon } from '@crystal-bridge/protocol';
import type { HubClient } from './hub.js';

export interface Circle {
  summons: Summon[];
  casts: Cast[];
}

const EMPTY: Circle = { summons: [], casts: [] };

/**
 * A Cast put in the list, replacing its older self. An end is final, so a running report that arrives after one is old:
 * the hub's record and its frames come by separate roads.
 */
export function withCast(casts: readonly Cast[], cast: Cast): Cast[] {
  const known = casts.find((candidate) => candidate.id === cast.id);
  if (known && known.state !== 'running' && cast.state === 'running') return [...casts];
  return [cast, ...casts.filter((candidate) => candidate.id !== cast.id)];
}

/**
 * A Kingdom's Summons and Casts: the hub's record, then each change as it happens. Frames aren't replayed, so the record
 * is read again whenever the socket comes back. A record can be older than a frame that lands while it's on its way, so
 * those frames go on top of it.
 */
export function useCircle(hub: HubClient, node: string | undefined): Circle {
  const [circle, setCircle] = useState(EMPTY);
  useEffect(() => {
    setCircle(EMPTY);
    if (!node) return;
    let latest = 0;
    let heard: Cast[] = [];
    const load = () => {
      latest += 1;
      const asked = latest;
      heard = [];
      void fetch(`/api/nodes/${encodeURIComponent(node)}/summons`)
        .then((response) => (response.ok ? (response.json() as Promise<Partial<Circle>>) : undefined))
        .then((loaded) => {
          if (!loaded || asked !== latest) return;
          setCircle({ summons: loaded.summons ?? [], casts: heard.reduce(withCast, loaded.casts ?? []) });
        })
        .catch(() => {});
    };
    load();
    const stopCasts = hub.onCast((from, cast) => {
      if (from !== node) return;
      heard.push(cast);
      setCircle((known) => ({ ...known, casts: withCast(known.casts, cast) }));
    });
    const stopReconnect = hub.onReconnect(load);
    return () => {
      latest += 1;
      stopCasts();
      stopReconnect();
    };
  }, [hub, node]);
  return circle;
}
