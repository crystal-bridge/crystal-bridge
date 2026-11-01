import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Cast } from '@crystal-bridge/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSummons,
  HERE,
  parseSummons,
  sshArgs,
  summonCall,
  type Summons,
  type SummonsOptions,
  type Target,
  summonDescription,
} from './summons.js';

const SESSION = '11111111-1111-4111-8111-111111111111';

async function until<T>(read: () => T | undefined | false, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('parseSummons', () => {
  it('reads host names, with an optional name of the user’s, and always has the Kingdom itself', () => {
    expect(parseSummons('render, Shiva=gpu-box.lan', 'linux')).toEqual([
      { name: HERE },
      { name: 'render', host: 'render' },
      { name: 'Shiva', host: 'gpu-box.lan' },
    ]);
    expect(parseSummons(undefined, 'linux')).toEqual([{ name: HERE }]);
  });

  it('leaves the Kingdom out on Windows, where the wrapper has no shell', () => {
    expect(parseSummons('render', 'win32')).toEqual([{ name: 'render', host: 'render' }]);
  });

  it('reads how many Casts a machine runs at once', () => {
    expect(parseSummons('render/2,Shiva=gpu.lan/3', 'win32')).toEqual([
      { name: 'render', host: 'render', limit: 2 },
      { name: 'Shiva', host: 'gpu.lan', limit: 3 },
    ]);
    expect(() => parseSummons('render/0', 'linux')).toThrow(/CRYSTAL_SUMMONS/);
    expect(() => parseSummons('render/x', 'linux')).toThrow(/CRYSTAL_SUMMONS/);
  });

  it('refuses a host that ssh would read as an option', () => {
    expect(() => parseSummons('-oProxyCommand=x', 'linux')).toThrow(/CRYSTAL_SUMMONS/);
    expect(() => parseSummons('a=b c', 'linux')).toThrow(/CRYSTAL_SUMMONS/);
  });
});

describe('sshArgs', () => {
  it('uses the machine’s own ssh setup and never prompts', () => {
    const args = sshArgs('render');
    expect(args).toContain('BatchMode=yes');
    expect(args.slice(-3)).toEqual(['--', 'render', 'sh -s']);
  });

  it('keeps the client’s own warnings out of what a target said', () => {
    expect(sshArgs('render')).toContain('LogLevel=ERROR');
  });
});

describe('summonCall', () => {
  const calls: unknown[] = [];
  const fake = {
    start: async (input: unknown) => (calls.push(input), { id: 'c' }),
    status: () => [],
    cancel: async () => ({ id: 'c' }),
  } as unknown as Summons;

  it('needs a choice of onFinish to start', async () => {
    await expect(summonCall(fake, 's', { action: 'start', summon: 'here', command: 'x' })).rejects.toThrow(/onFinish/);
    await expect(summonCall(fake, 's', { action: 'start', onFinish: 'notify' })).rejects.toThrow(/summon and command/);
    await expect(
      summonCall(fake, 's', { action: 'start', summon: 'here', command: 'x', onFinish: 'wake' }),
    ).resolves.toMatchObject({ id: 'c' });
    expect(calls).toEqual([{ session: 's', summon: 'here', command: 'x', onFinish: 'wake' }]);
  });

  it('needs a Cast to cancel', async () => {
    await expect(summonCall(fake, 's', { action: 'cancel' })).rejects.toThrow(/cast/);
  });
});

// The wrapper is POSIX sh, so Windows targets wait for their own (#128).
describe.skipIf(process.platform === 'win32')('a Cast on the Kingdom itself', () => {
  let home: string;
  let statePath: string;
  let reports: Cast[];
  let running: Summons[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cb-summons-'));
    statePath = join(home, 'casts.json');
    reports = [];
    running = [];
  });

  afterEach(async () => {
    for (const summons of running) summons.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    rmSync(home, { recursive: true, force: true });
  });

  const spawnOn = (_target: Target) =>
    spawn('sh', ['-s'], { cwd: home, env: { PATH: process.env.PATH, HOME: home, SHELL: '/bin/sh' } });

  function summons(options: Partial<SummonsOptions> = {}): Summons {
    const made = createSummons({
      targets: [{ name: HERE }],
      statePath,
      spawnOn,
      report: (cast) => reports.push(cast),
      reportMs: 10,
      retryMs: 20,
      settleMs: 10,
      probeMs: 100,
      ...options,
    });
    running.push(made);
    return made;
  }

  const start = (made: Summons, command: string, extra = {}) =>
    made.start({ session: SESSION, summon: HERE, command, onFinish: 'notify', ...extra });
  const final = (id: string) => until(() => reports.find((cast) => cast.id === id && cast.state !== 'running'));
  const folder = (id: string) => join(home, '.crystal-bridge', 'summons', id);

  it('runs a command, returns before it ends, and reports the log and the exit code', async () => {
    const made = summons();
    const cast = await start(made, 'echo one; sleep 1; echo two; exit 3');
    expect(cast).toMatchObject({ state: 'running', name: 'echo', summon: HERE });
    const done = await final(cast.id);
    expect(done).toMatchObject({ state: 'failed', exitCode: 3 });
    expect(done.logTail).toBe('one\ntwo\n');
    expect(readFileSync(join(folder(cast.id), 'exit'), 'utf8').trim()).toBe('3');
  });

  it('calls a clean exit a success, in the folder asked for, with the name asked for', async () => {
    const made = summons();
    const cast = await start(made, 'pwd', { cwd: '/', name: 'Where am I' });
    expect(cast.name).toBe('Where am I');
    expect(await final(cast.id)).toMatchObject({ state: 'succeeded', exitCode: 0, logTail: '/\n' });
  });

  it('carries a command with quotes, newlines and shell words through untouched', async () => {
    const made = summons();
    const command = `printf '%s\\n' "it's" '$HOME' \`echo tick\`\ncat <<'EOF'\nheredoc\nEOF`;
    const cast = await start(made, command);
    expect((await final(cast.id)).logTail).toBe(`it's\n$HOME\ntick\nheredoc\n`);
    expect(readFileSync(join(folder(cast.id), 'command'), 'utf8')).toBe(`${command}\n`);
  });

  it('keeps a job’s last lines when a routine check finds it ended before the log has been read', async () => {
    let spawned = 0;
    const slowFollow = (target: Target) => {
      spawned += 1;
      if (spawned !== 2) return spawnOn(target);
      // The start is the first shell, so this is the follow: slow to connect, as PowerShell is over SSH.
      return spawn('sh', ['-c', 'sleep 0.5; exec sh -s'], {
        cwd: home,
        env: { PATH: process.env.PATH, HOME: home, SHELL: '/bin/sh' },
      });
    };
    const made = summons({ spawnOn: slowFollow, probeMs: 50, settleMs: 2000 });
    const cast = await start(made, 'echo last; exit 3');
    const done = await final(cast.id);
    expect(done).toMatchObject({ state: 'failed', exitCode: 3 });
    expect(done.logTail).toBe('last\n');
  });

  it('refuses a folder that isn’t there, and leaves nothing behind', async () => {
    const made = summons();
    await expect(start(made, 'echo hi', { cwd: '/no/such/folder' })).rejects.toThrow(/no folder \/no\/such\/folder/);
    expect(made.status(SESSION)).toEqual([]);
    expect(readdirSync(join(home, '.crystal-bridge', 'summons'))).toEqual([]);
  });

  it('tells an agent that a cancel sends no wake', () => {
    expect(summonDescription([{ name: HERE }])).toMatch(/cancel[^.]*no wake/i);
  });

  it('isn’t fooled by a script printing the last line', async () => {
    const made = summons();
    const cast = await start(made, 'echo ::summon finished; sleep 1; echo real; exit 4');
    expect(await final(cast.id)).toMatchObject({ state: 'failed', exitCode: 4 });
  });

  it('refuses a Summon that isn’t listed, and says which are', async () => {
    await expect(start(summons(), 'true').then(() => 0)).resolves.toBe(0);
    await expect(
      summons().start({ session: SESSION, summon: 'nope', command: 'true', onFinish: 'notify' }),
    ).rejects.toThrow(/here/);
  });

  it('cancels the whole process group', async () => {
    const made = summons();
    const cast = await start(made, 'sleep 60 & echo $! > child; wait');
    const child = join(home, 'child');
    await until(() => existsSync(child) && readFileSync(child, 'utf8').trim());
    const pid = Number(readFileSync(child, 'utf8'));
    await made.cancel(SESSION, cast.id);
    expect(await final(cast.id)).toMatchObject({ state: 'cancelled' });
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('returns a cancel’s result when a slow target is already being checked', async () => {
    const made = summons({
      spawnOn: () =>
        spawn('sh', ['-c', 'sleep 1.5; exec sh -s'], {
          cwd: home,
          env: { PATH: process.env.PATH, HOME: home, SHELL: '/bin/sh' },
        }),
    });
    const cast = await start(made, 'sleep 30');
    const ended = await made.cancel(SESSION, cast.id);
    expect(ended).toMatchObject({ state: 'cancelled', exitCode: 143 });
  }, 20_000);

  it('won’t show or cancel another Quest’s Cast', async () => {
    const made = summons();
    const cast = await start(made, 'sleep 30');
    const other = '22222222-2222-4222-8222-222222222222';
    expect(made.status(other, cast.id)).toEqual([]);
    await expect(made.cancel(other, cast.id)).rejects.toThrow(/no such Cast/);
    await made.cancel(SESSION, cast.id);
  });

  it('picks up where it stopped after a restart, without repeating the log', async () => {
    const first = summons();
    const cast = await start(first, 'echo before; touch go; while [ ! -f release ]; do sleep 0.1; done; echo after');
    await until(() => reports.some((r) => r.id === cast.id && r.logTail.includes('before')));
    await new Promise((resolve) => setTimeout(resolve, 2100)); // the offset reaches the file
    first.close();
    expect(JSON.parse(readFileSync(statePath, 'utf8')).casts[0].offset).toBeGreaterThan(0);

    reports = [];
    const second = summons();
    second.resume();
    writeFileSync(join(home, 'release'), '');
    const done = await final(cast.id);
    expect(done).toMatchObject({ state: 'succeeded' });
    expect(done.logTail).toBe('before\nafter\n');
  });

  it('finds a job that finished while nobody watched', async () => {
    const first = summons();
    const cast = await start(first, 'echo quick');
    first.close();
    await until(() => existsSync(join(folder(cast.id), 'exit')));
    reports = [];
    summons().resume();
    expect(await final(cast.id)).toMatchObject({ state: 'succeeded', exitCode: 0 });
  });

  it('reports a job whose folder or process is gone as lost, and doesn’t retry it', async () => {
    const made = summons();
    const gone = await start(made, 'sleep 30');
    const killed = await start(made, 'sleep 30');
    const runner = Number(readFileSync(join(folder(killed.id), 'pid'), 'utf8').split(' ')[1]);
    process.kill(-runner, 'SIGKILL');
    rmSync(folder(gone.id), { recursive: true });
    expect(await final(killed.id)).toMatchObject({ state: 'lost' });
    expect(await final(gone.id)).toMatchObject({ state: 'lost' });
  });

  describe('a job ended by a signal', () => {
    /** The target's `systemctl`, saying how the system stands. */
    function withSystem(state: string): Partial<SummonsOptions> {
      const bin = join(home, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\necho ${state}\n`, { mode: 0o755 });
      return {
        spawnOn: () =>
          spawn('sh', ['-s'], {
            cwd: home,
            env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, SHELL: '/bin/sh' },
          }),
      };
    }

    it('is lost, not failed, when the system is shutting down', async () => {
      const cast = await start(summons(withSystem('stopping')), 'kill -TERM $$');
      expect((await final(cast.id)).state).toBe('lost');
      expect(existsSync(join(folder(cast.id), 'exit'))).toBe(false);
    });

    it('is failed when the system is running as usual', async () => {
      const cast = await start(summons(withSystem('running')), 'kill -TERM $$');
      expect(await final(cast.id)).toMatchObject({ state: 'failed', exitCode: 143 });
    });

    it('is lost when the machine has restarted since it began', async () => {
      const cast = await start(summons(), 'echo other > "$(dirname "$0")/boot"; kill -TERM $$');
      expect((await final(cast.id)).state).toBe('lost');
    });

    it('keeps its own exit code across a restart if it wasn’t signalled', async () => {
      const cast = await start(summons(), 'echo other > "$(dirname "$0")/boot"; exit 3');
      expect(await final(cast.id)).toMatchObject({ state: 'failed', exitCode: 3 });
    });

    it('stays cancelled during a shutdown', async () => {
      const made = summons(withSystem('stopping'));
      const cast = await start(made, 'sleep 30');
      const ended = await made.cancel(SESSION, cast.id);
      expect(ended.state).toBe('cancelled');
    });
  });

  it('keeps following through a dropped connection', async () => {
    const children: ReturnType<typeof spawn>[] = [];
    const made = summons({
      spawnOn: (target) => {
        const child = spawnOn(target);
        children.push(child);
        return child;
      },
    });
    const cast = await start(made, 'echo one; while [ ! -f release ]; do sleep 0.1; done; echo two');
    await until(() => reports.some((r) => r.id === cast.id && r.logTail.includes('one')));
    for (const child of children) child.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 100));
    writeFileSync(join(home, 'release'), '');
    expect((await final(cast.id)).logTail).toBe('one\ntwo\n');
  });

  it('keeps the Cast running while the target can’t be reached', async () => {
    let reachable = true;
    const made = summons({
      spawnOn: (target) => (reachable ? spawnOn(target) : spawn('sh', ['-c', 'exit 255'])),
    });
    const cast = await start(made, 'while [ ! -f release ]; do sleep 0.1; done');
    reachable = false;
    made.close();
    const second = summons({ spawnOn: (target) => (reachable ? spawnOn(target) : spawn('sh', ['-c', 'exit 255'])) });
    second.resume();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(second.casts()[0]).toMatchObject({ id: cast.id, state: 'running' });
    reachable = true;
    writeFileSync(join(home, 'release'), '');
    expect(await final(cast.id)).toMatchObject({ state: 'succeeded' });
  });

  it('takes a name and progress from lines the script prints, and keeps them out of the log', async () => {
    const made = summons();
    const cast = await start(
      made,
      "echo '::summon name Video Upscaler'; echo real; echo '::summon progress 12/50 episode 12.mkv'; sleep 0.3",
      { name: 'the tool’s name' },
    );
    await until(() => reports.some((r) => r.progress?.done === 12));
    const done = await final(cast.id);
    expect(done).toMatchObject({
      name: 'Video Upscaler',
      progress: { done: 12, total: 50, label: 'episode 12.mkv' },
      logTail: 'real\n',
    });
  });

  it('ignores a progress line it can’t read, as the log', async () => {
    const made = summons();
    const cast = await start(made, "echo '::summon progress lots'");
    const done = await final(cast.id);
    expect(done.progress).toBeUndefined();
    expect(done.logTail).toBe('::summon progress lots\n');
  });

  it('runs one Cast at a time on a machine, and two Kingdoms sharing it take turns', async () => {
    const hold = (name: string) => `echo started >> ${name}; while [ ! -f release-${name} ]; do sleep 0.1; done`;
    const first = summons();
    const a = await start(first, hold('a'));
    await until(() => existsSync(join(home, 'a')));

    const otherKingdom = summons({ statePath: join(home, 'other.json') });
    const b = await start(otherKingdom, hold('b'));
    await until(() => reports.some((r) => r.id === b.id && r.queued));
    expect(existsSync(join(home, 'b'))).toBe(false);
    expect(first.casts().map((cast) => cast.id)).toEqual([a.id]);
    expect(otherKingdom.casts().map((cast) => cast.id)).toEqual([b.id]);

    writeFileSync(join(home, 'release-a'), '');
    await final(a.id);
    await until(() => existsSync(join(home, 'b')));
    await until(() => reports.some((r) => r.id === b.id && r.state === 'running' && !r.queued));
    writeFileSync(join(home, 'release-b'), '');
    await final(b.id);
  });

  it('says so at once when a Cast has to wait, and not when it doesn’t', async () => {
    const made = summons();
    const first = await start(made, 'sleep 30');
    const second = await start(made, 'echo done');
    expect(first.queued).toBeUndefined();
    expect(second.queued).toBe(true);
    await made.cancel(SESSION, first.id);
    expect(await final(second.id)).toMatchObject({ state: 'succeeded' });
    expect(reports.filter((cast) => cast.id === second.id).at(-1)?.queued).toBeUndefined();
  });

  it('runs up to a raised limit at once', async () => {
    const made = summons({ targets: [{ name: HERE, limit: 2 }] });
    const hold = (name: string) => `echo x > ${name}; while [ ! -f release ]; do sleep 0.1; done`;
    const a = await start(made, hold('a'));
    const b = await start(made, hold('b'));
    await until(() => existsSync(join(home, 'a')) && existsSync(join(home, 'b')));
    writeFileSync(join(home, 'release'), '');
    await final(a.id);
    await final(b.id);
  });

  it('frees the turn of a job that was killed outright', async () => {
    const made = summons();
    const a = await start(made, 'sleep 30');
    const b = await start(made, 'echo mine');
    await until(() => reports.some((r) => r.id === b.id && r.queued));
    const group = Number(readFileSync(join(folder(a.id), 'pid'), 'utf8').split(' ')[1]);
    process.kill(-group, 'SIGKILL');
    expect(await final(b.id)).toMatchObject({ state: 'succeeded', logTail: 'mine\n' });
  });

  it('cancels a Cast still waiting for its turn', async () => {
    const made = summons();
    const a = await start(made, 'sleep 30');
    const b = await start(made, 'echo never > ran');
    await until(() => reports.some((r) => r.id === b.id && r.queued));
    await made.cancel(SESSION, b.id);
    expect(await final(b.id)).toMatchObject({ state: 'cancelled' });
    expect(existsSync(join(home, 'ran'))).toBe(false);
    await made.cancel(SESSION, a.id);
  });

  describe('a finished Cast past its week', () => {
    const WEEK = 7 * 24 * 60 * 60_000;
    let clock: number;
    let reachable: boolean;
    let cleans: number;

    // A target that's off: anything but a script that would clean fails the way ssh does.
    const flaky = (target: Target) => {
      const child = spawnOn(target);
      if (reachable) return child;
      cleans += 1;
      child.kill('SIGKILL');
      return child;
    };
    const finished = async (made: Summons) => {
      const cast = await start(made, 'echo done');
      await final(cast.id);
      clock += WEEK + 1;
      return cast;
    };
    const recorded = (id: string): boolean => existsSync(statePath) && readFileSync(statePath, 'utf8').includes(id);

    beforeEach(() => {
      clock = 1_000_000;
      reachable = true;
      cleans = 0;
    });

    it('removes its folder, then its record', async () => {
      const made = summons({ now: () => clock, probeMs: 20 });
      const cast = await finished(made);
      await until(() => !existsSync(folder(cast.id)) && !recorded(cast.id));
      expect(made.casts()).toEqual([]);
    });

    it('stays on record until a target that was off is back', async () => {
      const made = summons({ now: () => clock, probeMs: 20, spawnOn: flaky });
      const cast = await start(made, 'echo done');
      await final(cast.id);
      reachable = false;
      clock += WEEK + 1;
      await until(() => cleans >= 3);
      expect(existsSync(folder(cast.id))).toBe(true);
      expect(made.casts().map((c) => c.id)).toEqual([cast.id]);

      reachable = true;
      await until(() => !existsSync(folder(cast.id)));
      await until(() => made.casts().length === 0);
    });

    it('spends one connection on a target that’s off, however many Casts are waiting', async () => {
      const made = summons({ now: () => clock, probeMs: 40, spawnOn: flaky });
      await final((await start(made, 'echo a')).id);
      await final((await start(made, 'echo b')).id);
      await final((await start(made, 'echo c')).id);
      reachable = false;
      clock += WEEK + 1;
      const passes = 5;
      const opened = Date.now();
      await until(() => cleans >= passes);
      // Three Casts a pass would get here in two passes.
      expect(Date.now() - opened).toBeGreaterThanOrEqual((passes - 2) * 40);
      expect(made.casts()).toHaveLength(3);
    });

    it('goes on to the next Cast when the target answers but one folder won’t go', async () => {
      const stuck: string[] = [];
      const made = summons({
        now: () => clock,
        probeMs: 20,
        spawnOn: (target) => {
          const child = spawnOn(target);
          const end = child.stdin.end.bind(child.stdin);
          child.stdin.end = ((script: string) =>
            end(stuck.some((id) => script.includes(`rm -rf`) && script.includes(id)) ? 'exit 1\n' : script)) as never;
          return child;
        },
      });
      const a = await start(made, 'echo a');
      await final(a.id);
      const b = await start(made, 'echo b');
      await final(b.id);
      stuck.push(a.id);
      clock += WEEK + 1;
      await until(() => !existsSync(folder(b.id)));
      await until(() => made.casts().length === 1);
      expect(made.casts()[0]?.id).toBe(a.id);
    });

    it('forgets a Cast whose Summon is off the list, since nothing can reach its folder', async () => {
      const first = summons({ now: () => clock, probeMs: 60_000 });
      const cast = await start(first, 'echo done');
      await final(cast.id);
      first.close();
      clock += WEEK + 1;
      const later = summons({ now: () => clock, probeMs: 60_000, targets: [{ name: 'other', host: 'other.example' }] });
      later.resume();
      expect(later.casts()).toEqual([]);
    });

    it('keeps trying after a restart', async () => {
      const first = summons({ now: () => clock, probeMs: 60_000 });
      const cast = await start(first, 'echo done');
      await final(cast.id);
      first.close();
      clock += WEEK + 1;
      reachable = false;
      const later = summons({ now: () => clock, probeMs: 20, spawnOn: flaky });
      later.resume();
      await until(() => cleans >= 2);
      expect(later.casts().map((c) => c.id)).toEqual([cast.id]);
      reachable = true;
      await until(() => !existsSync(folder(cast.id)));
    });
  });

  it('says so in the log when a machine won’t let a job outlive its SSH session', async () => {
    const made = summons({
      targets: [{ name: 'old', host: 'old.example' }],
      spawnOn: () => spawn('sh', ['-c', 'cat >/dev/null; echo not-detached; echo started']),
    });
    const cast = await made.start({ session: SESSION, summon: 'old', command: 'x', onFinish: 'notify' });
    expect(cast.logTail).toMatch(/SSH session/);
  });

  it('survives noise a shell startup file prints before the log', async () => {
    const made = summons({
      spawnOn: () =>
        spawn('sh', ['-c', 'echo welcome to the box; exec sh -s'], {
          cwd: home,
          env: { PATH: process.env.PATH, HOME: home, SHELL: '/bin/sh' },
        }),
    });
    const cast = await start(made, 'echo real');
    expect((await final(cast.id)).logTail).toBe('real\n');
  });
});
