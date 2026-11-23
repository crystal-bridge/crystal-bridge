import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FINISH_CEILING_MS, gitChanges, reportChanges } from './changes.js';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'cb-changes-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: dir });
  git('init', '-q');
  writeFileSync(join(dir, 'kept.ts'), '1');
  writeFileSync(join(dir, 'gone.ts'), '1');
  git('add', '.');
  git('commit', '-qm', 'one');
  return { dir, git };
}

describe('gitChanges', () => {
  it('keeps the next turn-s start when it begins as the last one finishes', async () => {
    const { dir } = repo();
    const changes = gitChanges(dir);
    await changes.begin();
    const finished = changes.finish();
    const begun = changes.begin();
    await Promise.all([finished, begun]);
    writeFileSync(join(dir, 'kept.ts'), '2');
    expect(await changes.finish()).toEqual(['kept.ts']);
  });

  it('sees edits from any tool: committed, uncommitted, new and deleted', async () => {
    const { dir, git } = repo();
    const changes = gitChanges(dir);
    await changes.begin();
    writeFileSync(join(dir, 'kept.ts'), '2');
    git('commit', '-qam', 'two');
    writeFileSync(join(dir, 'new.ts'), '1');
    rmSync(join(dir, 'gone.ts'));
    expect(await changes.finish()).toEqual(['gone.ts', 'kept.ts', 'new.ts']);
  });

  it('leaves out what was already changed when the turn began, and ignored files', async () => {
    const { dir, git } = repo();
    writeFileSync(join(dir, '.gitignore'), 'out/\n');
    git('add', '.gitignore');
    git('commit', '-qm', 'ignore');
    writeFileSync(join(dir, 'kept.ts'), 'mine');
    const changes = gitChanges(dir);
    await changes.begin();
    mkdirSync(join(dir, 'out'));
    writeFileSync(join(dir, 'out', 'x.js'), '1');
    writeFileSync(join(dir, 'new.ts'), '1');
    expect(await changes.finish()).toEqual(['new.ts']);
  });

  it('counts everything in a repository with no commits yet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-changes-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const changes = gitChanges(dir);
    await changes.begin();
    writeFileSync(join(dir, 'first.ts'), '1');
    expect(await changes.finish()).toEqual(['first.ts']);
  });

  it('names files relative to a Quest in a subfolder', async () => {
    const { dir, git } = repo();
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'a.ts'), '1');
    git('add', '.');
    git('commit', '-qm', 'sub');
    const changes = gitChanges(join(dir, 'sub'));
    await changes.begin();
    writeFileSync(join(dir, 'sub', 'a.ts'), '2');
    expect(await changes.finish()).toEqual(['a.ts']);
  });

  it('reports nothing for a folder that is not a repository, or a turn it never saw begin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-changes-'));
    const changes = gitChanges(dir);
    expect(await changes.finish()).toBeUndefined();
    await changes.begin();
    expect(await changes.finish()).toBeUndefined();
  });

  describe('a repository’s own config', () => {
    /** Config that runs a command of the Quest's choosing, which writes down the token it can see. */
    function fsmonitor(dir: string) {
      const seen = join(dir, '..', `${basename(dir)}-seen`);
      const script = join(dir, '.git', 'monitor.sh');
      writeFileSync(script, `#!/bin/sh\nprintf '%s' "$CRYSTAL_TOKEN" >> '${seen}'\n`);
      chmodSync(script, 0o755);
      execFileSync('git', ['config', 'core.fsmonitor', script], { cwd: dir });
      return seen;
    }
    afterEach(() => void vi.unstubAllEnvs());

    it('shows git no token, and runs no fsmonitor', async () => {
      vi.stubEnv('CRYSTAL_TOKEN', 'secret');
      const { dir } = repo();
      const seen = fsmonitor(dir);
      const { CRYSTAL_TOKEN: _token, ...env } = process.env;
      const changes = gitChanges(dir, { env });
      await changes.begin();
      writeFileSync(join(dir, 'new.ts'), '1');
      expect(await changes.finish()).toEqual(['new.ts']);
      expect(existsSync(seen)).toBe(false);
    });

    it('runs none however it was called', async () => {
      vi.stubEnv('CRYSTAL_TOKEN', 'secret');
      const { dir } = repo();
      const seen = fsmonitor(dir);
      const changes = gitChanges(dir);
      await changes.begin();
      await changes.finish();
      expect(existsSync(seen)).toBe(false);
    });
  });

  it('caps a very long list', async () => {
    const { dir } = repo();
    const changes = gitChanges(dir, { maxFiles: 2 });
    await changes.begin();
    for (const name of ['a', 'b', 'c']) writeFileSync(join(dir, name), '1');
    expect(await changes.finish()).toHaveLength(2);
  });
});

describe('reportChanges', () => {
  const tracker = (files: string[] | undefined) => ({ begin: async () => {}, finish: async () => files });

  it('calls back with the diff once it’s in, even when it found nothing', async () => {
    const emit = vi.fn();
    const diffed = vi.fn();
    reportChanges(tracker([]), emit, diffed);
    await vi.waitFor(() => expect(diffed).toHaveBeenCalledWith([]));
    expect(emit).not.toHaveBeenCalled();

    const order: string[] = [];
    reportChanges(
      tracker(['a.ts']),
      (payload) => order.push(`emit ${JSON.stringify(payload.raw)}`),
      (files) => order.push(`diffed ${JSON.stringify(files)}`),
    );
    await vi.waitFor(() => expect(order).toHaveLength(2));
    expect(order).toEqual([
      `emit ${JSON.stringify({ type: 'system', subtype: 'turn_changes', files: ['a.ts'] })}`,
      'diffed ["a.ts"]',
    ]);
  });

  it('calls back with nothing known when the tracker can’t tell', async () => {
    const emit = vi.fn();
    const diffed = vi.fn();
    reportChanges(tracker(undefined), emit, diffed);
    await vi.waitFor(() => expect(diffed).toHaveBeenCalledWith(undefined));
    expect(emit).not.toHaveBeenCalled();
  });

  it('calls back with nothing known, and leaves no unhandled rejection, when the tracker fails', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const emit = vi.fn();
      const diffed = vi.fn();
      const failing = { begin: async () => {}, finish: () => Promise.reject(new Error('git is gone')) };
      reportChanges(failing, emit, diffed);
      await vi.waitFor(() => expect(diffed).toHaveBeenCalledWith(undefined));
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0]![0])).toMatch(/^\[crystal\] .*git is gone/);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
      expect(emit).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('calls back in turn order when a later turn’s diff is in first', async () => {
    const order: string[] = [];
    let slow: (files: string[]) => void = () => {};
    const first = { begin: async () => {}, finish: () => new Promise<string[]>((r) => (slow = r)) };
    const emit = (payload: { raw: unknown }) =>
      order.push(`emit ${JSON.stringify((payload.raw as { files: string[] }).files)}`);
    const tallied = reportChanges(first, emit, (files) => order.push(`diffed ${JSON.stringify(files)}`));
    const next = tracker(['b.ts']);
    const finished = vi.spyOn(next, 'finish');
    const second = reportChanges(next, emit, (files) => order.push(`diffed ${JSON.stringify(files)}`), tallied);
    // The second diff starts at once: only the sending waits for the slow first turn.
    expect(finished).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual([]);
    slow(['a.ts']);
    await second;
    expect(order).toEqual(['emit ["a.ts"]', 'diffed ["a.ts"]', 'emit ["b.ts"]', 'diffed ["b.ts"]']);
  });

  it('keeps reporting later turns when a callback throws', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const emit = vi.fn();
      const second = vi.fn();
      const first = reportChanges(tracker(['a.ts']), emit, () => {
        throw new Error('tally lost');
      });
      const tallied = reportChanges(tracker(['b.ts']), emit, second, first);
      await expect(first).resolves.toBeUndefined();
      await expect(tallied).resolves.toBeUndefined();
      expect(emit).toHaveBeenCalledTimes(2);
      expect(second).toHaveBeenCalledWith(['b.ts']);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0]![0])).toMatch(/^\[crystal\] .*tally lost/);
    } finally {
      logged.mockRestore();
    }
  });

  it('still calls back when sending the line throws', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const diffed = vi.fn();
      const emit = () => {
        throw new Error('socket gone');
      };
      await reportChanges(tracker(['a.ts']), emit, diffed);
      expect(diffed).toHaveBeenCalledWith(['a.ts']);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });

  it('gives up on a diff that never comes, and the next turn follows', async () => {
    vi.useFakeTimers();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const order: string[] = [];
      const stuck = { begin: async () => {}, finish: () => new Promise<string[]>(() => {}) };
      const first = reportChanges(stuck, vi.fn(), (files) => order.push(`first ${JSON.stringify(files)}`));
      reportChanges(tracker(['b.ts']), vi.fn(), (files) => order.push(`second ${JSON.stringify(files)}`), first);
      await vi.advanceTimersByTimeAsync(FINISH_CEILING_MS - 1);
      expect(order).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(order).toEqual(['first undefined', 'second ["b.ts"]']);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0]![0])).toMatch(/^\[crystal\] /);
    } finally {
      logged.mockRestore();
      vi.useRealTimers();
    }
  });

  it('still calls back, and the next turn follows, when the tracker throws at once', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const order: string[] = [];
      const throwing = {
        begin: async () => {},
        finish: (): Promise<string[] | undefined> => {
          throw new Error('x');
        },
      };
      const first = reportChanges(throwing, vi.fn(), (files) => order.push(`first ${JSON.stringify(files)}`));
      await reportChanges(tracker(['b.ts']), vi.fn(), (files) => order.push(`second ${JSON.stringify(files)}`), first);
      expect(order).toEqual(['first undefined', 'second ["b.ts"]']);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });

  it('ignores a failed earlier report', async () => {
    const diffed = vi.fn();
    await reportChanges(tracker(['b.ts']), vi.fn(), diffed, Promise.reject(new Error('earlier')));
    expect(diffed).toHaveBeenCalledWith(['b.ts']);
  });

  it('with no tracker, calls back at once with nothing known', () => {
    const emit = vi.fn();
    const diffed = vi.fn();
    reportChanges(undefined, emit, diffed);
    expect(diffed).toHaveBeenCalledWith(undefined);
    expect(emit).not.toHaveBeenCalled();
  });
});
