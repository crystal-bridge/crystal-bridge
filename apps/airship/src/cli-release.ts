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
 * The least time between two checks, even pressed for: two minutes caps presses at 30 calls an hour, which leaves room in
 * GitHub's 60 anonymous calls an hour for the scheduled checks and the updater's.
 */
const PRESS_GAP_MS = 2 * 60_000;

/** How a press went: GitHub answered, the hub had asked moments before, or GitHub didn't answer. */
export type CheckOutcome = 'answered' | 'recent' | 'failed';

/** A check run at most once per period; `refresh` asks now, and `checkedAt` is when it last got an answer. */
export interface PeriodicCheck<T> {
  (): Promise<T | undefined>;
  refresh(): Promise<CheckOutcome>;
  checkedAt(): number | undefined;
}

/**
 * Runs a check at most once per period, whoever is asking, and keeps the last good answer through a failure, so an
 * offline hub only stops saying an update is available. A press skips the period, though not within two minutes of the
 * last try, and a check already under way is waited for rather than asked twice.
 */
export function periodically<T>(
  check: () => Promise<T | undefined>,
  { now = Date.now, ttlMs = TTL_MS }: { now?: () => number; ttlMs?: number } = {},
): PeriodicCheck<T> {
  let latest: T | undefined;
  let triedAt: number | undefined;
  let answeredAt: number | undefined;
  let pending: Promise<boolean> | undefined;
  const attempt = (): Promise<boolean> => {
    const at = now();
    triedAt = at;
    pending = (async () => {
      try {
        const answer = await check();
        if (answer === undefined) return false;
        latest = answer;
        answeredAt = at;
        return true;
      } catch {
        // Keeps the last answer.
        return false;
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  };
  const due = (gap: number) => triedAt === undefined || now() - triedAt > gap;
  const run = async () => {
    if (pending) await pending;
    else if (due(ttlMs)) await attempt();
    return latest;
  };
  const refresh = async (): Promise<CheckOutcome> => {
    if (pending) return (await pending) ? 'answered' : 'failed';
    if (due(PRESS_GAP_MS)) return (await attempt()) ? 'answered' : 'failed';
    return answeredAt === triedAt ? 'recent' : 'failed';
  };
  return Object.assign(run, { refresh, checkedAt: () => answeredAt });
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
