import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Cast } from '@crystal-bridge/protocol';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { WINDOWS_COMMAND, windowsEnvelope, windowsScripts } from './summon-scripts-windows.js';
import { createSummons, sshArgs, targetKind, targetShell, type Summons, type Target } from './summons.js';

/** Over real SSH when `SUMMON_TEST_WINDOWS_HOST` names a machine; otherwise, on a Windows runner, on this machine. */
const HOST = process.env.SUMMON_TEST_WINDOWS_HOST;
const SESSION = '11111111-1111-4111-8111-111111111111';
const RELEASE = '$env:TEMP\\cb-summon-release';

async function until<T>(read: () => T | undefined | false, timeoutMs = 45_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function powershell(body: string): string {
  // Removing a file that isn't there still counts as a failure unless this says otherwise.
  const script = `${body}; exit 0`;
  const args = ['-NoProfile', '-NonInteractive', '-Command', script];
  if (!HOST) return execFileSync('powershell', args).toString();
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return execFileSync('ssh', [
    ...sshArgs(HOST, `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`),
  ]).toString();
}

describe.runIf(HOST || process.platform === 'win32')('a Cast on a Windows target', () => {
  const home = mkdtempSync(join(tmpdir(), 'cb-summons-win-'));
  const target: Target = HOST ? { name: 'win', host: HOST } : { name: 'win' };
  const viaSsh = targetShell(process.env, home);
  const shell = (to: Target) => {
    if (to.host) return viaSsh(to, 'windows');
    const parts = WINDOWS_COMMAND.split(' ');
    return spawn(parts[0]!, parts.slice(1));
  };
  let running: Summons[] = [];
  let reports: Cast[] = [];
  let children: ReturnType<typeof spawn>[] = [];

  const summons = (statePath = 'casts.json') => {
    const made = createSummons({
      targets: () => [target],
      statePath: join(home, statePath),
      spawnOn: (to) => {
        const child = shell(to);
        children.push(child);
        return child;
      },
      kindOf: async () => 'windows',
      report: (cast) => reports.push(cast),
      reportMs: 10,
      retryMs: 200,
      // Longer than a follow takes to connect: PowerShell is slow to start on a busy runner.
      settleMs: 5000,
      probeMs: 1000,
    });
    running.push(made);
    return made;
  };
  const start = (made: Summons, command: string, extra = {}) =>
    made.start({ session: SESSION, summon: 'win', command, onFinish: 'notify', ...extra });
  const final = (id: string) => until(() => reports.find((cast) => cast.id === id && cast.state !== 'running'));
  const forget = (id: string) =>
    powershell(`Remove-Item "$env:USERPROFILE\\.crystal-bridge\\summons\\${id}" -Recurse -Force -ErrorAction Ignore`);

  afterEach(() => {
    for (const made of running) made.close();
    running = [];
    reports = [];
    children = [];
  });

  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('runs a command and reports its log, exit code, name and progress', async () => {
    const made = summons();
    const cast = await start(
      made,
      `Write-Output '::summon name Café run'\nWrite-Output one\nWrite-Output '::summon progress 1/2 first'\nexit 3`,
    );
    const done = await final(cast.id);
    expect(done).toMatchObject({ state: 'failed', exitCode: 3, name: 'Café run', progress: { done: 1, total: 2 } });
    expect(done.logTail.trim()).toBe('one');
    forget(cast.id);
  }, 90_000);

  it('passes on a native tool’s exit code, in the folder asked for', async () => {
    const made = summons();
    const cast = await start(made, 'cmd /c "cd & exit 4"', { cwd: 'C:\\Windows' });
    const done = await final(cast.id);
    expect(done).toMatchObject({ state: 'failed', exitCode: 4 });
    expect(done.logTail.trim()).toBe('C:\\Windows');
    forget(cast.id);
  }, 90_000);

  it('refuses a folder that isn’t there', async () => {
    await expect(start(summons(), 'Write-Output hi', { cwd: 'C:\\no\\such\\folder' })).rejects.toThrow(/no folder/);
  });

  it('survives a dropped connection and a restart with no gap or repeat', async () => {
    powershell(`Remove-Item "${RELEASE}" -ErrorAction Ignore`);
    const first = summons();
    const cast = await start(
      first,
      `Write-Output one\nwhile (-not (Test-Path "${RELEASE}")) { Start-Sleep -Milliseconds 200 }\nWrite-Output two`,
    );
    await until(() => reports.some((report) => report.logTail.includes('one')));
    for (const child of children) child.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 3000));
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 1000));

    reports = [];
    summons().resume();
    powershell(`New-Item -ItemType File "${RELEASE}" -Force | Out-Null`);
    const done = await final(cast.id);
    expect(done).toMatchObject({ state: 'succeeded', exitCode: 0 });
    expect(done.logTail.replaceAll('\r', '')).toBe('one\ntwo\n');
    powershell(`Remove-Item "${RELEASE}" -ErrorAction Ignore`);
    forget(cast.id);
  }, 120_000);

  it('says when a folder wouldn’t go, so a Cast isn’t forgotten too soon', async () => {
    const id = 'clean-test';
    const dir = `$env:USERPROFILE\\.crystal-bridge\\summons\\${id}`;
    const clean = () =>
      new Promise<number | null>((resolve) => {
        const child = shell(target);
        child.on('close', resolve);
        child.stdin!.end(windowsEnvelope(windowsScripts.clean(id)));
      });
    const denied = powershell(
      `$me = [Security.Principal.WindowsIdentity]::GetCurrent().Name; ` +
        `New-Item -ItemType Directory "${dir}" -Force | Out-Null; ` +
        `New-Item -ItemType File "${dir}\\log" -Force | Out-Null; ` +
        `icacls "${dir}" /deny "\${me}:(DC)" | Out-Null; icacls "${dir}\\log" /deny "\${me}:(D)" | Out-Null; ` +
        `icacls "${dir}\\log"`,
    );
    expect(denied).toContain('DENY');
    expect(await clean()).toBe(1);
    powershell(`icacls "${dir}\\log" /reset | Out-Null; icacls "${dir}" /reset | Out-Null`);
    expect(await clean()).toBe(0);
  }, 60_000);

  it('cancels the job and everything it started, even a Cast waiting for its turn', async () => {
    const made = summons();
    const a = await start(made, 'cmd /c "ping -n 300 127.0.0.1"');
    await until(() => reports.some((report) => report.logTail.includes('Pinging')));
    const b = await start(made, 'Write-Output never');
    expect(b.queued).toBe(true);
    await made.cancel(SESSION, b.id);
    expect(await final(b.id)).toMatchObject({ state: 'cancelled' });
    expect((await made.cancel(SESSION, a.id)).state).toBe('cancelled');
    expect(powershell('(Get-Process ping -ErrorAction Ignore | Measure-Object).Count').trim()).toBe('0');
    forget(a.id);
    forget(b.id);
  }, 120_000);

  it('reports a job whose runner was killed as lost, and frees its turn', async () => {
    const made = summons();
    const a = await start(made, 'Start-Sleep 120');
    const b = await start(made, 'Write-Output mine');
    await until(() => reports.some((report) => report.id === b.id && report.queued));
    powershell(
      `$p = ((Get-Content "$env:USERPROFILE\\.crystal-bridge\\summons\\${a.id}\\pid") -split ' ')[0]; Stop-Process -Id $p -Force`,
    );
    expect(await final(a.id)).toMatchObject({ state: 'lost' });
    expect(await final(b.id)).toMatchObject({ state: 'succeeded' });
    forget(a.id);
    forget(b.id);
  }, 120_000);

  it.runIf(HOST)('knows a Windows machine when it sees one', async () => {
    await expect(targetKind(process.env)(target)).resolves.toBe('windows');
  });
});
