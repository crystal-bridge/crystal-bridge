import { RELEASE_REPO, ReleaseVersion } from '@crystal-bridge/protocol';
import { periodically } from './cli-release.js';

const TIMEOUT_MS = 5000;
const MAX_NOTES = 4000;

/** A published release, as the app shows it. */
export interface LatestRelease {
  version: string;
  url: string;
  notes: string;
}

export interface LatestReleaseOptions {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  ttlMs?: number;
}

interface GitHubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  body?: unknown;
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

/**
 * What asks GitHub for this project's latest full release: pre-releases don't count, and it sends nothing about the hub
 * but the request itself. GitHub allows 60 anonymous calls an hour per address, far more than this needs.
 */
export function latestReleaseChecker({ fetch: request = fetch, now, ttlMs }: LatestReleaseOptions = {}): () => Promise<
  LatestRelease | undefined
> {
  return periodically(
    async () => {
      const response = await request(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'crystal-bridge-airship' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return response.ok ? parseRelease((await response.json()) as GitHubRelease) : undefined;
    },
    { ...(now ? { now } : {}), ...(ttlMs ? { ttlMs } : {}) },
  );
}
