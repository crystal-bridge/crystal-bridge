import { execFile } from 'node:child_process';

/** An hour: the CLI updates itself, and this runs a whole process just to ask. */
const TTL_MS = 60 * 60 * 1000;

/** The version out of what `claude --version` prints, e.g. `2.1.314 (Claude Code)`. */
export function parseCliVersion(output: string): string | undefined {
  return /^\s*(\d+\.\d+\.\d+\S*)/.exec(output)?.[1];
}

export interface CliVersionOptions {
  exec: () => Promise<string>;
  now?: () => number;
  ttlMs?: number;
}

/** The CLI's version, asked for at most once per period; undefined when it can't be run. */
export function cachedCliVersion({
  exec,
  now = Date.now,
  ttlMs = TTL_MS,
}: CliVersionOptions): () => Promise<string | undefined> {
  let version: string | undefined;
  let checkedAt: number | undefined;
  return async () => {
    if (checkedAt !== undefined && now() - checkedAt <= ttlMs) return version;
    checkedAt = now();
    version = await exec().then(parseCliVersion, () => undefined);
    return version;
  };
}

/** Runs `<bin> --version`, in the environment sessions get. */
export function execCliVersion(bin: string, env: NodeJS.ProcessEnv): () => Promise<string> {
  return () =>
    new Promise((resolve, reject) => {
      execFile(bin, ['--version'], { env, timeout: 10_000 }, (error, stdout) =>
        error ? reject(error) : resolve(stdout),
      );
    });
}
