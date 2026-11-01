import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
