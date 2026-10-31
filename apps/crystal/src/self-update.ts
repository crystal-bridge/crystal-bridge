import { isOlderVersion, type SelfUpdate } from '@crystal-bridge/protocol';

export interface UpdaterDeps {
  /** The version running now. */
  current: string;
  /** Versions this Kingdom was rolled back from, which it won't take again. */
  held: () => string[];
  /** Downloads, verifies and installs a release beside the running one. */
  stage: (version: string) => Promise<void>;
  /** Makes a staged release the one the next start runs. */
  activate: (version: string) => void;
  /** Whether any Quest here is mid-turn or holds background work. */
  busy: () => boolean;
  report: (state: SelfUpdate) => void;
  /** Ends this process so the service manager starts the new release. */
  restart: () => void;
  log: (line: string) => void;
  pollMs?: number;
  retryMs?: number;
}

const POLL_MS = 30_000;
const RETRY_MS = 3_600_000;

/**
 * Follows the version the hub names. The hub only gets to name one: what's run is decided by `stage`, which checks the
 * release on its own, and by the rule here that a Kingdom only ever moves forward. So a taken-over hub can't get its own
 * code run, or walk a Kingdom back onto an old release with a known hole. Going back is a local act (`rollback`).
 */
export function createUpdater(deps: UpdaterDeps) {
  const { pollMs = POLL_MS, retryMs = RETRY_MS } = deps;
  let wanted: string | undefined;
  let last: SelfUpdate | undefined;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  /** Bumped by every change of plan, so a run that was overtaken stops at its next step. */
  let run = 0;
  /** An install can't be stopped partway and two would write the same files, so a change of plan waits for it. */
  let staging = false;

  function report(state: SelfUpdate): void {
    last = state;
    deps.report(state);
  }

  function fail(version: string, error: unknown, thisRun: number): void {
    const reason = error instanceof Error ? error.message : String(error);
    deps.log(`[crystal:update] ${version} failed: ${reason}`);
    report({ version, state: 'failed', reason });
    timer = setTimeout(() => void install(version, thisRun), retryMs);
  }

  async function install(version: string, thisRun: number): Promise<void> {
    report({ version, state: 'installing' });
    staging = true;
    let failure: { error: unknown } | undefined;
    try {
      await deps.stage(version);
    } catch (error) {
      failure = { error };
    }
    staging = false;
    if (thisRun !== run) {
      if (wanted && !closed) void install(wanted, run);
      return;
    }
    if (failure) return fail(version, failure.error, thisRun);
    report({ version, state: 'waiting' });
    waitForIdle(version, thisRun, 0);
  }

  /** Two quiet checks in a row, so a restart doesn't land in the moment between a Quest's turns. */
  function waitForIdle(version: string, thisRun: number, quiet: number): void {
    timer = setTimeout(() => {
      if (thisRun !== run) return;
      const count = deps.busy() ? 0 : quiet + 1;
      if (count < 2) return waitForIdle(version, thisRun, count);
      try {
        deps.activate(version);
      } catch (error) {
        return fail(version, error, thisRun);
      }
      report({ version, state: 'restarting' });
      deps.restart();
    }, pollMs);
  }

  return {
    /** The version the hub names; unset stands down, even partway through. */
    target(version: string | undefined): void {
      if (closed) return;
      if (version === wanted) {
        if (last) deps.report(last);
        return;
      }
      clearTimeout(timer);
      run++;
      last = undefined;
      if (!version || !isOlderVersion(deps.current, version) || deps.held().includes(version)) {
        wanted = undefined;
        return;
      }
      wanted = version;
      if (!staging) void install(version, run);
    },
    close(): void {
      closed = true;
      run++;
      clearTimeout(timer);
    },
  };
}
