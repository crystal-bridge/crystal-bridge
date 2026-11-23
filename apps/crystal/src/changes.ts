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
/**
 * The longest a turn's diff may hold up the tallies after it. git's own timeout should end it sooner, but a git stuck
 * in uninterruptible I/O never exits, and so never settles.
 */
export const FINISH_CEILING_MS = 4 * GIT_TIMEOUT_MS;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const MAX_FILES = 500;

type GitEnv = Record<string, string | undefined>;

function git(cwd: string, base: GitEnv, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      // The folder is the Quest's and so is its config: a repo's fsmonitor is a command git would run for us.
      ['-c', 'core.fsmonitor=false', ...args],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        // Reads only: never take the index lock from the agent's own git commands.
        env: { ...base, GIT_OPTIONAL_LOCKS: '0' },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin?.end();
  });
}

const names = (output: string) => output.split('\0').filter(Boolean);

/** Paths that differ from `base` in the working tree, plus untracked ones; relative to `cwd`. */
async function changedSince(cwd: string, env: GitEnv, base: string): Promise<Set<string>> {
  const [diff, untracked] = await Promise.all([
    git(cwd, env, 'diff', '--name-only', '--relative', '-z', base),
    git(cwd, env, 'ls-files', '--others', '--exclude-standard', '-z'),
  ]);
  return new Set([...names(diff), ...names(untracked)]);
}

/** The commit to compare with, or the empty tree in a repository with none yet; rejects outside a repository. */
async function startingPoint(cwd: string, env: GitEnv): Promise<string> {
  try {
    return await git(cwd, env, 'rev-parse', '--verify', '--quiet', 'HEAD');
  } catch {
    return git(cwd, env, 'hash-object', '-t', 'tree', '--stdin');
  }
}

/**
 * Compares the working tree with the commit the turn began on, which covers work the turn committed as well as work
 * it left uncommitted. Files already changed when the turn began are left out: they aren't this turn's. Moving HEAD
 * onto other people's commits (a pull) counts as change. Outside a repository `finish` gives undefined, and the
 * client falls back on the file tools it saw. `env` is what git and anything it runs get: pass the sessions' own.
 */
export function gitChanges(
  cwd: string,
  { maxFiles = MAX_FILES, env = process.env }: { maxFiles?: number; env?: GitEnv } = {},
): TurnChanges {
  let began: Promise<{ head: string; dirty: Set<string> } | undefined> | undefined;
  return {
    async begin() {
      began = (async () => {
        const head = (await startingPoint(cwd, env)).trim();
        return { head, dirty: await changedSince(cwd, env, head) };
      })().catch(() => undefined);
      await began;
    },
    async finish() {
      // Taken at once: the next turn's `begin` can run while this one waits.
      const beginning = began;
      began = undefined;
      const start = await beginning;
      if (!start) return undefined;
      try {
        const changed = await changedSince(cwd, env, start.head);
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
 * so closing a Quest as a turn ends can't lose it. The client reads the line as belonging to the turn before it. Then
 * calls `diffed` with the diff (even an empty one), or with undefined at once when there is no tracker or it can't
 * tell, so the turn's tally can go out. `after` is the previous turn's report: the diff is taken at once, but this
 * turn's line and callback wait for that one's, so tallies go out in turn order however long each diff takes. Pass
 * the returned promise as the next turn's `after`; it never rejects. A diff still out after `FINISH_CEILING_MS` counts
 * as unknown.
 */
export function reportChanges(
  changes: TurnChanges | undefined,
  emit: (payload: ClaudeEventPayload) => void,
  diffed: (files: string[] | undefined) => void,
  after: Promise<void> = Promise.resolve(),
): Promise<void> {
  // An earlier turn's failure is its own: this turn still reports, so one bad turn can't end a session's tallies.
  const previous = after.catch(() => undefined);
  if (!changes) {
    report(emit, diffed, undefined);
    return previous;
  }
  // `finish` shouldn't reject, but a tracker that does still lets the tally go out, with nothing known.
  let ceiling: NodeJS.Timeout | undefined;
  const files = Promise.race([
    // Called at once, but inside a promise, so a tracker that throws rather than rejects still lets the tally go out.
    new Promise<string[] | undefined>((resolve) => resolve(changes.finish())),
    new Promise<undefined>((resolve) => {
      ceiling = setTimeout(() => {
        console.error(
          `[crystal] a turn's changes took over ${FINISH_CEILING_MS / 1000} s: sending its tally without them`,
        );
        resolve(undefined);
      }, FINISH_CEILING_MS);
      ceiling.unref?.();
    }),
  ])
    .catch((error: unknown) => {
      console.error(`[crystal] a turn's changes could not be read: ${message(error)}`);
      return undefined;
    })
    .finally(() => clearTimeout(ceiling));
  return Promise.all([files, previous]).then(([files]) => report(emit, diffed, files));
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Sends one turn's line and calls back; a callback that throws is logged, never passed on to the next turn. */
function report(
  emit: (payload: ClaudeEventPayload) => void,
  diffed: (files: string[] | undefined) => void,
  files: string[] | undefined,
): void {
  const guarded = (send: () => void) => {
    try {
      send();
    } catch (error) {
      console.error(`[crystal] a turn's changes could not be sent: ${message(error)}`);
    }
  };
  if (files?.length) guarded(() => emit({ engine: 'claude', raw: { type: 'system', subtype: 'turn_changes', files } }));
  guarded(() => diffed(files));
}
