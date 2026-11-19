import { isOlderVersion, RELEASE_REPO, ReleaseVersion } from '@crystal-bridge/protocol';
import { periodically } from './cli-release.js';

const TIMEOUT_MS = 5000;
const MAX_NOTES = 4000;

/** A published release, as the app shows it. */
export interface LatestRelease {
  version: string;
  url: string;
  notes: string;
}

/** Which releases a hub follows: full releases, or every edge build of `main` too (docs/OPERATIONS.md, Releases). */
export type ReleaseChannel = 'stable' | 'edge';

export interface LatestReleaseOptions {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  ttlMs?: number;
  /** The hub's channel now; stable when absent. */
  channel?: () => ReleaseChannel;
}

interface GitHubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  body?: unknown;
  draft?: unknown;
}

function parseRelease({ tag_name: tag, html_url: url, body }: GitHubRelease): LatestRelease | undefined {
  const version = ReleaseVersion.safeParse(typeof tag === 'string' ? tag.replace(/^v/, '') : undefined);
  if (!version.success) return undefined;
  const notes = typeof body === 'string' ? body : '';
  return {
    version: version.data,
    // The page turns this into a link, so anything but a web address is replaced.
    url:
      typeof url === 'string' && url.startsWith('https://')
        ? url
        : `https://github.com/${RELEASE_REPO}/releases/tag/v${version.data}`,
    notes: notes.length > MAX_NOTES ? `${notes.slice(0, MAX_NOTES)}…` : notes,
  };
}

const API = `https://api.github.com/repos/${RELEASE_REPO}/releases`;
const HEADERS = { accept: 'application/vnd.github+json', 'user-agent': 'crystal-bridge-airship' };

/**
 * What asks GitHub for this project's newest release on the hub's channel: on stable, the latest full release, which
 * pre-releases never are; on edge, the newest of the recent releases, pre-releases included. It sends nothing about the
 * hub but the request itself. GitHub allows 60 anonymous calls an hour per address, far more than this needs. Each
 * channel keeps its own answer, so a change of channel asks at once.
 */
export function latestReleaseChecker({
  fetch: request = fetch,
  now,
  ttlMs,
  channel = () => 'stable',
}: LatestReleaseOptions = {}): () => Promise<LatestRelease | undefined> {
  const timing = { ...(now ? { now } : {}), ...(ttlMs ? { ttlMs } : {}) };
  const checkers: Record<ReleaseChannel, () => Promise<LatestRelease | undefined>> = {
    stable: periodically(async () => {
      const response = await request(`${API}/latest`, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
      return response.ok ? parseRelease((await response.json()) as GitHubRelease) : undefined;
    }, timing),
    edge: periodically(async () => {
      const response = await request(`${API}?per_page=30`, {
        headers: HEADERS,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) return undefined;
      const list = (await response.json()) as GitHubRelease[];
      const releases = (Array.isArray(list) ? list : [])
        .filter((one) => one.draft !== true)
        .flatMap((one) => parseRelease(one) ?? []);
      return releases.reduce<LatestRelease | undefined>(
        (newest, one) => (!newest || isOlderVersion(newest.version, one.version) ? one : newest),
        undefined,
      );
    }, timing),
  };
  return () => checkers[channel()]();
}
