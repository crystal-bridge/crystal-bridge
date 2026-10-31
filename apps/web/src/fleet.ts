import type { SelfUpdate } from '@crystal-bridge/protocol';
import { isBehind, releaseLabel } from './release.js';

/** One Kingdom, as the Ship's Log lists it. */
export interface FleetRow {
  id: string;
  name: string;
  connected: boolean;
  release?: string | undefined;
  selfUpdate?: SelfUpdate | undefined;
}

/** A Kingdom's release in a few words, and whether someone needs to look. Waiting on its own Quests doesn't count. */
export function fleetLine(row: FleetRow, hubRelease: string): { text: string; attention: boolean } {
  if (!row.connected) return { text: 'offline', attention: false };
  const release = row.release ? releaseLabel(row.release) : 'unknown release';
  const update = row.selfUpdate;
  if (update?.state === 'failed') {
    const reason = update.reason ? `: ${update.reason}` : '';
    return { text: `${release}, could not move to ${update.version}${reason}`, attention: true };
  }
  if (update?.state === 'waiting') {
    return { text: `${release}, ${update.version} is ready and waits for its Quests`, attention: false };
  }
  if (update) return { text: `${release}, ${update.state} ${update.version}`, attention: false };
  if (isBehind(row.release, hubRelease)) return { text: `${release}, behind ${hubRelease}`, attention: true };
  return { text: release, attention: false };
}
