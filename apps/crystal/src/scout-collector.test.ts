import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnCollector } from './scouts.js';

const NODE = process.execPath;

/** Whether a process is still there; signal 0 only checks. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('spawnCollector', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'collector-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function script(name: string, body: string): void {
    writeFileSync(join(cwd, name), body);
  }

  const env = (extra: Record<string, string> = {}) => ({ ...(process.env as Record<string, string>), ...extra });

  it('runs the command in the Scout’s folder with the environment given, and returns what it printed', async () => {
    script(
      'collect.mjs',
      `process.stdout.write(JSON.stringify({ cwd: process.cwd(), state: process.env.CRYSTAL_SCOUT_STATE }));
       process.stderr.write('one warning\\n');`,
    );
    const { result } = spawnCollector({
      cwd,
      command: [NODE, 'collect.mjs'],
      env: env({ CRYSTAL_SCOUT_STATE: 'here' }),
      timeoutMs: 10_000,
    });
    const done = await result;
    expect(done).toMatchObject({ kind: 'exited', code: 0, stderr: 'one warning\n' });
    const printed = JSON.parse((done as { stdout: string }).stdout) as { cwd: string; state: string };
    expect(printed.state).toBe('here');
    expect(readFileSync(join(printed.cwd, 'collect.mjs'), 'utf8')).toContain('CRYSTAL_SCOUT_STATE');
  });

  it('reports the exit code of a collector that fails', async () => {
    script('fail.mjs', `process.exit(4)`);
    const { result } = spawnCollector({ cwd, command: [NODE, 'fail.mjs'], env: env(), timeoutMs: 10_000 });
    expect(await result).toMatchObject({ kind: 'exited', code: 4 });
  });

  it('says a command that is not there could not start', async () => {
    const { result } = spawnCollector({ cwd, command: ['./no-such-collector'], env: env(), timeoutMs: 10_000 });
    expect(await result).toMatchObject({ kind: 'not-started', message: expect.stringMatching(/ENOENT/) });
  });

  it('stops a collector that runs past its timeout', async () => {
    script('hang.mjs', `process.stderr.write('started\\n'); setInterval(() => {}, 1000);`);
    const started = Date.now();
    const { result } = spawnCollector({ cwd, command: [NODE, 'hang.mjs'], env: env(), timeoutMs: 500 });
    expect(await result).toEqual({ kind: 'timed-out', stderr: 'started\n' });
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  it.skipIf(process.platform === 'win32')('stops what the collector started, too', async () => {
    script(
      'parent.mjs',
      `import { spawn } from 'node:child_process';
       import { writeFileSync } from 'node:fs';
       const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
       writeFileSync('child.pid', String(child.pid));
       setInterval(() => {}, 1000);`,
    );
    const { result } = spawnCollector({ cwd, command: [NODE, 'parent.mjs'], env: env(), timeoutMs: 1_000 });
    expect((await result).kind).toBe('timed-out');
    expect(existsSync(join(cwd, 'child.pid'))).toBe(true);
    const pid = Number(readFileSync(join(cwd, 'child.pid'), 'utf8'));
    await expect.poll(() => alive(pid), { timeout: 5_000 }).toBe(false);
  });

  it('stops a collector that prints more than it may', async () => {
    script('flood.mjs', `const line = 'x'.repeat(1024); setInterval(() => process.stdout.write(line), 1);`);
    const { result } = spawnCollector({
      cwd,
      command: [NODE, 'flood.mjs'],
      env: env(),
      timeoutMs: 10_000,
      maxStdout: 64 * 1024,
    });
    expect((await result).kind).toBe('too-much');
  });

  it('can be stopped from outside', async () => {
    script('hang.mjs', `setInterval(() => {}, 1000);`);
    const collector = spawnCollector({ cwd, command: [NODE, 'hang.mjs'], env: env(), timeoutMs: 60_000 });
    collector.stop();
    expect((await collector.result).kind).toBe('exited');
  });
});
