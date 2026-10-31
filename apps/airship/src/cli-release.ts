/** Where the agent CLI's latest release is published. */
const LATEST_URL = 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest';
/** Releases come often, but nobody needs to hear within the hour. */
const TTL_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 5000;

export interface LatestCliOptions {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  ttlMs?: number;
}

/**
 * Runs a check at most once per period, whoever is asking, and keeps the last good answer through a failure, so an
 * offline hub only stops saying an update is available.
 */
export function periodically<T>(
  check: () => Promise<T | undefined>,
  { now = Date.now, ttlMs = TTL_MS }: { now?: () => number; ttlMs?: number } = {},
): () => Promise<T | undefined> {
  let latest: T | undefined;
  let checkedAt: number | undefined;
  return async () => {
    if (checkedAt !== undefined && now() - checkedAt <= ttlMs) return latest;
    checkedAt = now();
    try {
      latest = (await check()) ?? latest;
    } catch {
      // Keeps the last answer.
    }
    return latest;
  };
}

/** What asks for the latest agent CLI version. */
export function latestCliChecker({ fetch: request = fetch, now, ttlMs }: LatestCliOptions = {}): () => Promise<
  string | undefined
> {
  return periodically(
    async () => {
      const response = await request(LATEST_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      const body = response.ok ? ((await response.json()) as { version?: unknown }) : {};
      return typeof body.version === 'string' ? body.version : undefined;
    },
    { ...(now ? { now } : {}), ...(ttlMs ? { ttlMs } : {}) },
  );
}
