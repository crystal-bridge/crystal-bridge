import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Cast } from '@crystal-bridge/protocol';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createSummons, sshArgs, targetShell, type Summons } from './summons.js';

/** A real `sshd`, which CI's `summons-ssh` job sets up. Elsewhere this file is skipped. */
const HOST = process.env.SUMMON_TEST_HOST;
const SESSION = '11111111-1111-4111-8111-111111111111';

async function until<T>(read: () => T | undefined | false, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const onTarget = (script: string) => execFileSync('ssh', ['-o', 'BatchMode=yes', HOST!, script]).toString();

describe.runIf(HOST)('a Cast over real SSH', () => {
  const home = mkdtempSync(join(tmpdir(), 'cb-summons-ssh-'));
  const shell = targetShell(process.env, home);
  let running: Summons[] = [];
  let reports: Cast[] = [];
  let children: ReturnType<typeof spawn>[] = [];

  const summons = () => {
    const made = createSummons({
      targets: [{ name: 'box', host: HOST! }],
      statePath: join(home, 'casts.json'),
      spawnOn: (target) => {
        const child = shell(target);
        children.push(child);
        return child;
      },
      report: (cast) => reports.push(cast),
      reportMs: 10,
      retryMs: 100,
      settleMs: 50,
    });
    running.push(made);
    return made;
  };

  afterEach(() => {
    for (const made of running) made.close();
    running = [];
    reports = [];
    children = [];
  });

  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('survives a dropped connection and a restart, and leaves no tail behind', async () => {
    const first = summons();
    const cast = await first.start({
      session: SESSION,
      summon: 'box',
      command: 'echo one; while [ ! -f /tmp/cb-summon-release ]; do sleep 0.2; done; echo two; exit 5',
      onFinish: 'notify',
    });
    await until(() => reports.some((report) => report.logTail.includes('one')));
    const tails = () => onTarget(`pgrep -fc '[t]ail -c .*${cast.id}' || true`).trim();
    for (const child of children) child.kill('SIGKILL');
    // Back on one connection, with the dropped one's tail gone.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await until(() => tails() === '1');
    await new Promise((resolve) => setTimeout(resolve, 2100)); // the offset reaches the file
    first.close();
    await until(() => tails() === '0');

    reports = [];
    summons().resume();
    await until(() => tails() === '1');
    onTarget('touch /tmp/cb-summon-release');
    const done = await until(() => reports.find((report) => report.state !== 'running'));
    expect(done).toMatchObject({ state: 'failed', exitCode: 5 });
    expect(done.logTail).toBe('one\ntwo\n');
    onTarget(`rm -rf ~/.crystal-bridge/summons/${cast.id} /tmp/cb-summon-release`);
  }, 60_000);

  it('cancels over SSH', async () => {
    const made = summons();
    const cast = await made.start({ session: SESSION, summon: 'box', command: 'sleep 300', onFinish: 'notify' });
    await made.cancel(SESSION, cast.id);
    expect(await until(() => reports.find((report) => report.state !== 'running'))).toMatchObject({
      state: 'cancelled',
    });
    expect(onTarget(`pgrep -fc '[s]ummons/${cast.id}' || true`).trim()).toBe('0');
    onTarget(`rm -rf ~/.crystal-bridge/summons/${cast.id}`);
  }, 60_000);

  it('fails at once on a host it can’t reach, without prompting', async () => {
    const made = createSummons({
      targets: [{ name: 'nowhere', host: 'nowhere.invalid' }],
      statePath: join(home, 'none.json'),
      spawnOn: shell,
      report: () => undefined,
    });
    running.push(made);
    await expect(
      made.start({ session: SESSION, summon: 'nowhere', command: 'true', onFinish: 'notify' }),
    ).rejects.toThrow(/could not start on nowhere/);
    expect(made.casts()).toEqual([]);
    expect(sshArgs('x')).toContain('BatchMode=yes');
  }, 40_000);
});
