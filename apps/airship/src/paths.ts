import { chmodSync, closeSync, existsSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Makes a file only its owner can read, creating it if it's missing, so it's never open to others even for a moment.
 * The hub's database and backups hold every conversation. A disk that can't do this shouldn't stop the hub.
 */
export function makePrivate(file: string): void {
  try {
    if (!existsSync(file)) closeSync(openSync(file, 'a', 0o600));
    chmodSync(file, 0o600);
  } catch (error) {
    console.warn(`[airship] could not make ${file} private`, error);
  }
}

export interface HubPaths {
  db: string;
  /** Undefined means no node tokens, which only a development hub may start with. */
  nodes: string | undefined;
  tokens: string;
  vapid: string;
  settings: string;
  backups: string;
}

/**
 * Where the hub keeps things. AIRSHIP_DATA puts everything in one folder, as a container or a fresh install wants. Without
 * it, the older settings keep the meanings a running hub relies on. Any single path can still be overridden.
 */
export function hubPaths(env: NodeJS.ProcessEnv): HubPaths {
  const data = env.AIRSHIP_DATA;
  const db = env.AIRSHIP_DB ?? (data ? join(data, 'airship.db') : './airship.db');
  const beside = data ?? dirname(db);
  return {
    db,
    nodes: env.AIRSHIP_NODES ?? (data ? join(data, 'nodes.json') : undefined),
    tokens: env.AIRSHIP_TOKENS ?? join(beside, 'access-tokens.json'),
    vapid: env.AIRSHIP_VAPID_PATH ?? join(beside, 'vapid.json'),
    settings: join(beside, 'hub.json'),
    backups: env.AIRSHIP_BACKUP_DIR ?? (data ? join(data, 'backups') : './backups'),
  };
}
