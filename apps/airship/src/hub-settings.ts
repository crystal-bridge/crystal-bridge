import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { ReleaseVersion } from '@crystal-bridge/protocol';
import { z } from 'zod';
import type { ReleaseChannel } from './hub-release.js';

const MAX_NAME = 40;

/** The hub's own settings. In a file rather than the database, so adding one never blocks a rollback. */
export interface HubSettings {
  name(): string | undefined;
  /** Sets the name, or clears it with undefined. */
  setName(name: string | undefined): void;
  kingdomUpdates(): KingdomUpdates;
  setKingdomUpdates(choice: KingdomUpdates): void;
  /** Full releases only (`stable`), or every edge build of `main` too. */
  channel(): ReleaseChannel;
  setChannel(channel: ReleaseChannel): void;
  /** Install updates asked to approve Kingdoms to this version once the hub runs it (`takeKingdomApproval`). */
  setKingdomApprovalAfter(version: string): void;
  /** Whether that's due now that the hub runs `version`; true once, then forgotten. */
  takeKingdomApproval(version: string): boolean;
}

/**
 * Whether Kingdoms follow the hub on their own, or wait to be told. `approved` is the release they may move to. Either
 * way the hub only names a version, and each Kingdom checks that release itself.
 */
export const KingdomUpdates = z.object({
  mode: z.enum(['auto', 'approved']),
  approved: ReleaseVersion.optional(),
});
export type KingdomUpdates = z.infer<typeof KingdomUpdates>;

const SettingsFile = z.object({
  name: z.string().optional(),
  kingdomUpdates: KingdomUpdates.optional(),
  channel: z.enum(['stable', 'edge']).optional(),
  approveKingdomsAfter: ReleaseVersion.optional(),
});
type SettingsFile = z.infer<typeof SettingsFile>;

/** A name ready to store, '' for none, or undefined for one that can't be shown. */
export function cleanHubName(name: string): string | undefined {
  const trimmed = name.trim();
  return trimmed.length > MAX_NAME || /[\u0000-\u001f\u007f]/.test(trimmed) ? undefined : trimmed;
}

/** Reads the file on every call, like the token files, and replaces it in one step. */
export function loadHubSettings(path: string): HubSettings {
  const read = (): SettingsFile => (existsSync(path) ? SettingsFile.parse(JSON.parse(readFileSync(path, 'utf8'))) : {});
  const write = (settings: SettingsFile): void => {
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  };
  return {
    name: () => read().name,
    setName(name) {
      const { name: _old, ...rest } = read();
      write(name === undefined ? rest : { ...rest, name });
    },
    kingdomUpdates: () => read().kingdomUpdates ?? { mode: 'auto' },
    setKingdomUpdates(kingdomUpdates) {
      write({ ...read(), kingdomUpdates });
    },
    channel: () => read().channel ?? 'stable',
    setChannel(channel) {
      write({ ...read(), channel });
    },
    setKingdomApprovalAfter(approveKingdomsAfter) {
      write({ ...read(), approveKingdomsAfter });
    },
    takeKingdomApproval(version) {
      const { approveKingdomsAfter, ...rest } = read();
      if (approveKingdomsAfter !== version) return false;
      write(rest);
      return true;
    },
  };
}
