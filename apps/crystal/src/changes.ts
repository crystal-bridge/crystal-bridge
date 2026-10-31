import { execFile } from 'node:child_process';
import type { ClaudeEventPayload } from './session.js';

/** What a turn changed in its folder, however it changed it: file tools, a shell, a formatter or a generator. */
export interface TurnChanges {
  /** The turn opened: resolves once the starting point is recorded. */
  begin(): Promise<void>;
  /** The turn ended: the changed paths, or undefined when they can't be known. Never rejects. */
  finish(): Promise<string[] | undefined>;
}

const GIT_TIMEOUT_MS = 3000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const MAX_FILES = 500;

function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        // Reads only: never take the index lock from the agent's own git commands.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin?.end();
  });
}

const names = (output: string) => output.split('\0').filter(Boolean);

/** Paths that differ from `base` in the working tree, plus untracked ones; relative to `cwd`. */
async function changedSince(cwd: string, base: string): Promise<Set<string>> {
  const [diff, untracked] = await Promise.all([
    git(cwd, 'diff', '--name-only', '--relative', '-z', base),
    git(cwd, 'ls-files', '--others', '--exclude-standard', '-z'),
  ]);
  return new Set([...names(diff), ...names(untracked)]);
}

/** The commit to compare with, or the empty tree in a repository with none yet; rejects outside a repository. */
async function startingPoint(cwd: string): Promise<string> {
  try {
    return await git(cwd, 'rev-parse', '--verify', '--quiet', 'HEAD');
  } catch {
    return git(cwd, 'hash-object', '-t', 'tree', '--stdin');
  }
}

/**
 * Compares the working tree with the commit the turn began on, which covers work the turn committed as well as work
 * it left uncommitted. Files already changed when the turn began are left out: they aren't this turn's. Moving HEAD
 * onto other people's commits (a pull) counts as change. Outside a repository `finish` gives undefined, and the
 * client falls back on the file tools it saw.
 */
export function gitChanges(cwd: string, { maxFiles = MAX_FILES }: { maxFiles?: number } = {}): TurnChanges {
  let began: Promise<{ head: string; dirty: Set<string> } | undefined> | undefined;
  return {
    async begin() {
      began = (async () => {
        const head = (await startingPoint(cwd)).trim();
        return { head, dirty: await changedSince(cwd, head) };
      })().catch(() => undefined);
      await began;
    },
    async finish() {
      const start = await began;
      began = undefined;
      if (!start) return undefined;
      try {
        const changed = await changedSince(cwd, start.head);
        return [...changed]
          .filter((path) => !start.dirty.has(path))
          .sort()
          .slice(0, maxFiles);
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * Sends a finished turn's changed files as a line of their own, after `turn.finished`: that event never waits on git,
 * so closing a Quest as a turn ends can't lose it. The client reads the line as belonging to the turn before it.
 */
export function reportChanges(changes: TurnChanges | undefined, emit: (payload: ClaudeEventPayload) => void): void {
  void changes?.finish().then((files) => {
    if (files?.length) emit({ engine: 'claude', raw: { type: 'system', subtype: 'turn_changes', files } });
  });
}
