import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

const MAX_NAME = 40;

/** The hub's own settings. In a file rather than the database, so adding one never blocks a rollback. */
export interface HubSettings {
  name(): string | undefined;
  /** Sets the name, or clears it with undefined. */
  setName(name: string | undefined): void;
}

const SettingsFile = z.object({ name: z.string().optional() });

/** A name ready to store, '' for none, or undefined for one that can't be shown. */
export function cleanHubName(name: string): string | undefined {
  const trimmed = name.trim();
  return trimmed.length > MAX_NAME || /[\u0000-\u001f\u007f]/.test(trimmed) ? undefined : trimmed;
}

/** Reads the file on every call, like the token files, and replaces it in one step. */
export function loadHubSettings(path: string): HubSettings {
  return {
    name() {
      return existsSync(path) ? SettingsFile.parse(JSON.parse(readFileSync(path, 'utf8'))).name : undefined;
    },
    setName(name) {
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(name === undefined ? {} : { name }, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, path);
    },
  };
}
