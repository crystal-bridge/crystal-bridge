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
 * What asks for the latest agent CLI version: at most once per period, whoever is asking, and with the last good answer
 * kept through a failure, so an offline hub only stops saying an update is available.
 */
export function latestCliChecker({
  fetch: request = fetch,
  now = Date.now,
  ttlMs = TTL_MS,
}: LatestCliOptions = {}): () => Promise<string | undefined> {
  let latest: string | undefined;
  let checkedAt: number | undefined;
  return async () => {
    if (checkedAt !== undefined && now() - checkedAt <= ttlMs) return latest;
    checkedAt = now();
    try {
      const response = await request(LATEST_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      const body = response.ok ? ((await response.json()) as { version?: unknown }) : {};
      if (typeof body.version === 'string') latest = body.version;
    } catch {
      // Keeps the last answer.
    }
    return latest;
  };
}
