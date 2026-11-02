import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const app = fileURLToPath(new URL('..', import.meta.url));
const args = ['--import', 'tsx', 'src/main.ts'];

describe('the hub command', () => {
  let data: string;
  /** A hub of its own, on a port of its own, whatever this shell has set. */
  const env = () => ({
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AIRSHIP|CRYSTAL)_/.test(key))),
    AIRSHIP_DATA: data,
    AIRSHIP_DEV: '1',
    AIRSHIP_PORT: '0',
  });

  beforeEach(() => {
    data = mkdtempSync(join(tmpdir(), 'cb-hub-main-'));
  });
  afterEach(() => rmSync(data, { recursive: true, force: true }));

  it('refuses a subcommand it does not know, rather than starting a hub', () => {
    const { status, stderr } = spawnSync(process.execPath, [...args, 'tokens', 'list'], {
      cwd: app,
      env: env(),
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(stderr).toContain('unknown command "tokens"');
    expect(stderr).toContain('usage: crystal-bridge-airship');
    expect(status).toBe(1);
  }, 20_000);

  it('still starts on its own and with --dev, as `pnpm dev` runs it', async () => {
    const hub = spawn(process.execPath, [...args, '--dev'], { cwd: app, env: env() });
    let said = '';
    await new Promise<void>((resolve, reject) => {
      hub.stdout.on('data', (chunk: Buffer) => {
        said += chunk.toString();
        if (said.includes('listening on')) resolve();
      });
      hub.on('exit', () => reject(new Error(`the hub exited: ${said}`)));
    });
    const gone = new Promise((resolve) => hub.once('close', resolve));
    hub.removeAllListeners('exit');
    hub.kill();
    await gone;
  }, 20_000);
});
