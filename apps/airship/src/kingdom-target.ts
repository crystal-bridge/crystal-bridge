import { ReleaseVersion } from '@crystal-bridge/protocol';

/**
 * The Kingdom release this hub names, from `AIRSHIP_KINGDOM_VERSION`: a version, `off` for none, and unset for the hub's
 * own version, so a packaged hub brings its Kingdoms along. A hub run from git has no version, so it names none.
 */
export function kingdomTarget(setting: string | undefined, hubVersion: string | undefined): string | undefined {
  if (setting === 'off') return undefined;
  if (!setting) return hubVersion;
  const version = ReleaseVersion.safeParse(setting);
  if (!version.success) throw new Error(`AIRSHIP_KINGDOM_VERSION must be a version or off, not "${setting}"`);
  return version.data;
}
