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

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/;

/** Dot-separated pre-release parts, numbers as numbers, as semver orders them. */
function comparePrerelease(a: string, b: string): number {
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const order = (left[i] ?? '').localeCompare(right[i] ?? '', 'en', { numeric: true });
    if (order !== 0) return order;
  }
  return 0;
}

/**
 * Whether a Kingdom runs an older version than the hub. Only versions can be ordered: a commit, a dev build or a
 * missing release is never called behind.
 */
export function isBehind(node: string | undefined, hub: string | undefined): boolean {
  const left = node && VERSION.exec(node);
  const right = hub && VERSION.exec(hub);
  if (!left || !right) return false;
  for (const part of [1, 2, 3]) {
    const order = Number(left[part]) - Number(right[part]);
    if (order !== 0) return order < 0;
  }
  if (left[4] === undefined) return false;
  if (right[4] === undefined) return true;
  return comparePrerelease(left[4], right[4]) < 0;
}
