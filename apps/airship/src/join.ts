import { createHash, randomBytes } from 'node:crypto';

/** Long enough to copy a command across to a new machine and run it. */
const TTL_MS = 10 * 60 * 1000;

export interface JoinCodes {
  /** A new one-time code for the node, replacing any it had. */
  issue(node: string): { code: string; expiresAt: number };
  /** The node the code was made for, once; undefined for a wrong, used or expired code. */
  redeem(code: string): string | undefined;
}

function hash(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/**
 * One-time codes that trade for a node token. They're kept in memory as hashes, so restarting the hub cancels them.
 * 128 random bits: a machine copies the command rather than a person typing it, so length costs nothing and no attempt
 * limit is needed.
 */
export function createJoinCodes({ now = Date.now, ttlMs = TTL_MS } = {}): JoinCodes {
  const live = new Map<string, { node: string; expiresAt: number }>();
  return {
    issue(node) {
      for (const [key, entry] of live) {
        if (entry.node === node || entry.expiresAt <= now()) live.delete(key);
      }
      const code = randomBytes(16).toString('base64url');
      const expiresAt = now() + ttlMs;
      live.set(hash(code), { node, expiresAt });
      return { code, expiresAt };
    },
    redeem(code) {
      const key = hash(code);
      const entry = live.get(key);
      live.delete(key);
      return entry && entry.expiresAt > now() ? entry.node : undefined;
    },
  };
}
