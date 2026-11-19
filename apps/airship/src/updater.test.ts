import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyUpdate, readRequest, systemSteps, type UpdaterSteps, type UpdateStatus } from './updater.js';

function steps(overrides: Partial<UpdaterSteps> = {}) {
  const statuses: UpdateStatus[] = [];
  const calls: string[] = [];
  const base: UpdaterSteps = {
    wanted: () => ({ version: '0.6.1-edge.2' }),
    current: () => '0.6.1-edge.1',
    download: vi.fn(async (version) => {
      calls.push(`download ${version}`);
      return new Uint8Array([1, 2, 3]);
    }),
    verify: vi.fn(async (_tarball, version) => {
      calls.push(`verify ${version}`);
    }),
    install: vi.fn(async (version) => {
      calls.push(`install ${version}`);
    }),
    loads: vi.fn(async (version) => {
      calls.push(`loads ${version}`);
    }),
    activate: vi.fn((version) => {
      calls.push(`activate ${version}`);
    }),
    restart: vi.fn(async () => {
      calls.push('restart');
    }),
    healthy: vi.fn(async () => true),
    prune: vi.fn(() => {
      calls.push('prune');
    }),
    report: (status) => statuses.push(status),
    now: () => 1000,
    ...overrides,
  };
  return { steps: base, statuses, calls };
}

describe('applyUpdate: the hub-s updater, run as its own service', () => {
  it('checks, installs beside, swaps, restarts, and keeps the old release to go back to', async () => {
    const { steps: s, statuses, calls } = steps();
    await applyUpdate(s);
    expect(calls).toEqual([
      'download 0.6.1-edge.2',
      'verify 0.6.1-edge.2',
      'install 0.6.1-edge.2',
      'loads 0.6.1-edge.2',
      'activate 0.6.1-edge.2',
      'restart',
      'prune',
    ]);
    expect(statuses.map((status) => status.state)).toEqual(['installing', 'restarting', 'done']);
    expect(statuses.at(-1)).toEqual({ version: '0.6.1-edge.2', state: 'done', from: '0.6.1-edge.1', at: 1000 });
  });

  it('never moves to an older release, whatever the hub asked', async () => {
    const { steps: s, statuses, calls } = steps({ wanted: () => ({ version: '0.6.0' }) });
    await applyUpdate(s);
    expect(calls).toEqual([]);
    expect(statuses.at(-1)).toMatchObject({ state: 'failed', reason: '0.6.0 is not newer than 0.6.1-edge.1' });
  });

  it('does nothing, and leaves how the last one went, when asked for the release it runs', async () => {
    const { steps: s, statuses, calls } = steps({ wanted: () => ({ version: '0.6.1-edge.1' }) });
    await applyUpdate(s);
    expect(calls).toEqual([]);
    expect(statuses).toEqual([]);
  });

  it('waits for the hub to say it runs the new release, not just to answer', async () => {
    const healthy = vi.fn(async () => true);
    await applyUpdate(steps({ healthy }).steps);
    expect(healthy).toHaveBeenCalledWith('0.6.1-edge.2');
  });

  it('refuses a request that names no release, and does nothing when there is none', async () => {
    const bad = steps({ wanted: () => ({ version: '../../etc' }) });
    await applyUpdate(bad.steps);
    expect(bad.calls).toEqual([]);
    expect(bad.statuses.at(-1)).toMatchObject({ state: 'failed', reason: expect.stringMatching(/not a release/) });
    const none = steps({ wanted: () => undefined });
    await applyUpdate(none.steps);
    expect(none.statuses).toEqual([]);
  });

  it('installs nothing that fails its provenance check, and says why', async () => {
    const {
      steps: s,
      statuses,
      calls,
    } = steps({
      verify: vi.fn(async () => {
        throw new Error('release 0.6.1-edge.2 failed its provenance check: no attestation covers this file');
      }),
    });
    await applyUpdate(s);
    expect(calls).toEqual(['download 0.6.1-edge.2']);
    expect(statuses.at(-1)).toMatchObject({ state: 'failed', reason: expect.stringMatching(/provenance/) });
  });

  it('goes back to the release it ran when the new hub does not come up', async () => {
    const { steps: s, statuses, calls } = steps({ healthy: vi.fn(async (v: string) => v !== '0.6.1-edge.2') });
    await applyUpdate(s);
    expect(calls).toEqual([
      'download 0.6.1-edge.2',
      'verify 0.6.1-edge.2',
      'install 0.6.1-edge.2',
      'loads 0.6.1-edge.2',
      'activate 0.6.1-edge.2',
      'restart',
      'activate 0.6.1-edge.1',
      'restart',
    ]);
    expect(statuses.at(-1)).toMatchObject({
      state: 'failed',
      reason: expect.stringMatching(/did not come up.*back on 0\.6\.1-edge\.1/),
    });
  });

  it('leaves the running hub alone when the new one does not load', async () => {
    const {
      steps: s,
      statuses,
      calls,
    } = steps({
      loads: vi.fn(async () => {
        throw new Error('it says it is 0.6.0');
      }),
    });
    await applyUpdate(s);
    expect(calls).not.toContain('activate 0.6.1-edge.2');
    expect(statuses.at(-1)).toMatchObject({ state: 'failed', reason: expect.stringMatching(/it says it is 0\.6\.0/) });
  });

  it('goes back, and says so, when the swap or the restart throws', async () => {
    let restarts = 0;
    const {
      steps: s,
      statuses,
      calls,
    } = steps({
      healthy: vi.fn(async (v: string) => v !== '0.6.1-edge.2'),
      restart: vi.fn(async () => {
        restarts++;
        calls.push('restart');
        if (restarts === 1) throw new Error('systemctl failed: unit not found');
      }),
    });
    await applyUpdate(s);
    expect(calls.slice(-3)).toEqual(['restart', 'activate 0.6.1-edge.1', 'restart']);
    expect(statuses.at(-1)).toMatchObject({
      state: 'failed',
      reason: expect.stringMatching(/systemctl failed: unit not found.*back on 0\.6\.1-edge\.1/),
    });
  });

  it('says plainly when the old release does not come back either', async () => {
    const { steps: s, statuses } = steps({ healthy: vi.fn(async () => false) });
    await applyUpdate(s);
    expect(statuses.at(-1)?.reason).toMatch(/0\.6\.1-edge\.1 did not answer either: check the host/);
  });
});

describe('the updater-s steps on a host', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cb-updater-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads a request only from a small, plain file, never through a link or from a pipe', () => {
    const request = join(dir, 'update-request.json');
    expect(readRequest(request)).toBeUndefined();
    writeFileSync(request, JSON.stringify({ version: '1.2.3' }));
    expect(readRequest(request)).toEqual({ version: '1.2.3' });
    rmSync(request);
    writeFileSync(join(dir, 'secret.json'), JSON.stringify({ version: 'root-only' }));
    symlinkSync(join(dir, 'secret.json'), request);
    expect(readRequest(request)).toEqual({ version: 'unreadable request' });
    rmSync(request);
    expect(spawnSync('mkfifo', [request]).status).toBe(0);
    expect(readRequest(request)).toEqual({ version: 'unreadable request' });
    rmSync(request);
    writeFileSync(request, 'x'.repeat(10_000));
    expect(readRequest(request)).toEqual({ version: 'unreadable request' });
  });

  it('writes its status where it is told, and swaps current, and keeps the running release and the last two', () => {
    const root = join(dir, 'opt');
    const status = join(dir, 'state', 'status.json');
    mkdirSync(join(dir, 'state'));
    for (const [i, version] of ['0.1.0', '0.2.0', '0.3.0', '0.4.0', '0.5.0'].entries()) {
      mkdirSync(join(root, 'releases', version), { recursive: true });
      utimesSync(join(root, 'releases', version), i + 1, i + 1);
    }
    symlinkSync(join(root, 'releases', '0.4.0'), join(root, 'current'));
    const host = systemSteps({
      requestPath: join(dir, 'update-request.json'),
      statusPath: status,
      root,
      port: 1,
      user: 'nobody',
      service: 'airship.service',
    });
    expect(host.current()).toBe('0.4.0');
    host.activate('0.5.0');
    expect(readlinkSync(join(root, 'current'))).toBe(join(root, 'releases', '0.5.0'));
    expect(host.current()).toBe('0.5.0');
    host.prune();
    expect(['0.1.0', '0.2.0', '0.3.0', '0.4.0', '0.5.0'].filter((v) => existsSync(join(root, 'releases', v)))).toEqual([
      '0.3.0',
      '0.4.0',
      '0.5.0',
    ]);
    host.report({ version: '0.5.0', state: 'done', at: 1 });
    expect(existsSync(status)).toBe(true);
  });
});
