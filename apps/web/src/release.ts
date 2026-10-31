import { isOlderVersion } from '@crystal-bridge/protocol';

/** The release this page was built from: deploys set CB_RELEASE to the commit id; anything else is 'dev'. */
export const BUILD_RELEASE: string = __CB_RELEASE__;

/** Whether the hub now serves a different release than this page, so the user should reload. */
export function isOutdated(built: string, served: string | undefined): boolean {
  return served !== undefined && built !== 'dev' && served !== 'dev' && served !== built;
}

/** A commit is shortened to the usual seven characters; a version stays whole. */
export function releaseLabel(release: string): string {
  return /^[0-9a-f]{7,40}$/.test(release) ? release.slice(0, 7) : release;
}

/** Whether a Kingdom runs an older version than the hub. A commit, a dev build or a missing release is never behind. */
export const isBehind = isOlderVersion;
