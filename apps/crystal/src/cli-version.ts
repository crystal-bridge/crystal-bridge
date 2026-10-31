import { execFile } from 'node:child_process';
import { MAX_CLI_UPDATE_REASON } from '@crystal-bridge/protocol';

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

/**
 * The CLI's version, asked for at most once per period unless `fresh` says it may have changed; undefined when it can't
 * be run.
 */
export function cachedCliVersion({
  exec,
  now = Date.now,
  ttlMs = TTL_MS,
}: CliVersionOptions): (fresh?: boolean) => Promise<string | undefined> {
  let version: string | undefined;
  let checkedAt: number | undefined;
  return async (fresh = false) => {
    if (!fresh && checkedAt !== undefined && now() - checkedAt <= ttlMs) return version;
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

/** Long enough for a package manager, short enough that a stuck one doesn't hold the Kingdom's Update for good. */
const UPDATE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Runs `<bin> update`, the CLI's own documented command, which also hands off to a package manager when one installed
 * it. Stdin is closed so nothing can wait on an answer nobody can give, and a failure keeps the end of the output.
 */
export function execCliUpdate(bin: string, env: NodeJS.ProcessEnv, timeoutMs = UPDATE_TIMEOUT_MS): () => Promise<void> {
  return () =>
    new Promise((resolve, reject) => {
      const child = execFile(bin, ['update'], { env, timeout: timeoutMs }, (error, stdout, stderr) => {
        if (!error) return resolve();
        if (error.killed) return reject(new Error(`the update did not finish within ${timeoutMs / 1000} s`));
        const said = `${stdout}\n${stderr}`.trim();
        reject(new Error((said || error.message).slice(-MAX_CLI_UPDATE_REASON)));
      });
      child.stdin?.end();
    });
}
