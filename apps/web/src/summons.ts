import { useEffect, useState } from 'react';
import type { Cast, Summon } from '@crystal-bridge/protocol';
import type { HubClient } from './hub.js';

export interface Circle {
  summons: Summon[];
  casts: Cast[];
}

const EMPTY: Circle = { summons: [], casts: [] };

/** A Cast put in the list, replacing its older self. */
export function withCast(casts: readonly Cast[], cast: Cast): Cast[] {
  return [cast, ...casts.filter((known) => known.id !== cast.id)];
}

/** A Kingdom's Summons and Casts: the hub's record, then each change as it happens. */
export function useCircle(hub: HubClient, node: string | undefined): Circle {
  const [circle, setCircle] = useState(EMPTY);
  useEffect(() => {
    setCircle(EMPTY);
    if (!node) return;
    let current = true;
    void fetch(`/api/nodes/${encodeURIComponent(node)}/summons`)
      .then((response) => (response.ok ? (response.json() as Promise<Partial<Circle>>) : EMPTY))
      .then((loaded) => {
        if (current) setCircle({ summons: loaded.summons ?? [], casts: loaded.casts ?? [] });
      })
      .catch(() => {});
    const stop = hub.onCast((from, cast) => {
      if (from === node) setCircle((known) => ({ ...known, casts: withCast(known.casts, cast) }));
    });
    return () => {
      current = false;
      stop();
    };
  }, [hub, node]);
  return circle;
}
