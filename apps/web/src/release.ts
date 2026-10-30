/** The release this page was built from: deploys set CB_RELEASE to the commit id; anything else is 'dev'. */
export const BUILD_RELEASE: string = __CB_RELEASE__;

/** Whether the hub now serves a different release than this page, so the user should reload. */
export function isOutdated(built: string, served: string | undefined): boolean {
  return served !== undefined && built !== 'dev' && served !== 'dev' && served !== built;
}
