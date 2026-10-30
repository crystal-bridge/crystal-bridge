import { basename } from 'node:path';

/**
 * What this Crystal reports as its release: the version a packaged build carries, else the commit a deploy named its
 * release folder after (releases/<sha>). A checkout reports none.
 */
export function releaseId(version: string | undefined, releaseRoot: string): string | undefined {
  return version ?? /^[0-9a-f]{7,40}$/.exec(basename(releaseRoot))?.[0];
}
