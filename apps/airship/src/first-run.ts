import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { NodeRegistry } from './nodes.js';

export interface FirstRun {
  /** The setup code, for the hub's logs and nowhere else. */
  readonly code: string;
  /** Whether a hub with no logins can still be claimed. */
  pending(): boolean;
  /** The first login's token, once, for the right code while setup is pending. */
  claim(code: string, name: string): string | undefined;
}

function sha256(code: string): Buffer {
  return createHash('sha256').update(code).digest();
}

/**
 * How a hub with no logins gets its first one without ever being open: a code only someone who can read the logs has.
 * It's made on each start and kept in memory, 128 random bits, so a guess needs no attempt limit of its own, and a
 * wrong one doesn't spend it. A login made any other way ends setup.
 */
export function createFirstRun(tokens: Pick<NodeRegistry, 'ids' | 'issue'>): FirstRun {
  const code = randomBytes(16).toString('base64url');
  const expected = sha256(code);
  let claimed = false;
  const pending = () => !claimed && tokens.ids().length === 0;
  return {
    code,
    pending,
    claim(offered, name) {
      if (!pending() || !timingSafeEqual(sha256(offered), expected)) return undefined;
      claimed = true;
      return tokens.issue(name);
    },
  };
}
