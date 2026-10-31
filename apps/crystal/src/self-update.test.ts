import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SelfUpdate } from '@crystal-bridge/protocol';
import { createUpdater } from './self-update.js';

const POLL = 1000;
const RETRY = 60_000;

function setup(over: Partial<Parameters<typeof createUpdater>[0]> = {}) {
  const reports: SelfUpdate[] = [];
  let busy = false;
  const deps = {
    current: '1.0.0',
    held: () => [] as string[],
    stage: vi.fn(async () => undefined),
    activate: vi.fn(() => undefined),
    busy: () => busy,
    report: (state: SelfUpdate) => void reports.push(state),
    restart: vi.fn(),
    log: () => undefined,
    pollMs: POLL,
    retryMs: RETRY,
    ...over,
  };
  return { deps, reports, updater: createUpdater(deps), setBusy: (value: boolean) => (busy = value) };
}

describe('createUpdater', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it('installs a newer version, then swaps and restarts once idle for two checks in a row', async () => {
    const { deps, updater, reports } = setup();
    updater.target('1.1.0');
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.stage).toHaveBeenCalledWith('1.1.0');
    expect(deps.activate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(POLL * 2);
    expect(deps.activate).toHaveBeenCalledWith('1.1.0');
    expect(deps.restart).toHaveBeenCalledOnce();
    expect(reports.map(({ state }) => state)).toEqual(['installing', 'waiting', 'restarting']);
  });

  it('never swaps while a Quest is busy, and starts the idle count again after one', async () => {
    const { deps, updater, setBusy } = setup();
    setBusy(true);
    updater.target('1.1.0');
    await vi.advanceTimersByTimeAsync(POLL * 10);
    expect(deps.stage).toHaveBeenCalledOnce();
    expect(deps.activate).not.toHaveBeenCalled();

    setBusy(false);
    await vi.advanceTimersByTimeAsync(POLL);
    setBusy(true);
    await vi.advanceTimersByTimeAsync(POLL);
    setBusy(false);
    await vi.advanceTimersByTimeAsync(POLL);
    expect(deps.activate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(POLL);
    expect(deps.activate).toHaveBeenCalledOnce();
  });

  it('checks once more after the install: a Quest can start during the download', async () => {
    const { deps, updater, setBusy } = setup({
      stage: vi.fn(async () => void setBusy(true)),
    });
    updater.target('1.1.0');
    await vi.advanceTimersByTimeAsync(POLL * 5);
    expect(deps.activate).not.toHaveBeenCalled();
  });

  it.each([
    ['the running version', '1.0.0'],
    ['an older version', '0.9.0'],
    ['a pre-release of the running version', '1.0.0-rc.1'],
  ])('refuses %s: a hub can’t walk a Kingdom back', async (_, version) => {
    const { deps, updater, reports } = setup();
    updater.target(version);
    await vi.advanceTimersByTimeAsync(POLL * 5);
    expect(deps.stage).not.toHaveBeenCalled();
    expect(reports).toEqual([]);
  });

  it('leaves alone a version this Kingdom was rolled back from, but takes the next one', async () => {
    const { deps, updater } = setup({ held: () => ['1.1.0'] });
    updater.target('1.1.0');
    await vi.advanceTimersByTimeAsync(POLL * 5);
    expect(deps.stage).not.toHaveBeenCalled();
    updater.target('1.2.0');
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.stage).toHaveBeenCalledWith('1.2.0');
  });

  it('says why an install failed, keeps running this version and tries again later', async () => {
    const stage = vi.fn(async () => undefined);
    stage.mockRejectedValueOnce(new Error('failed its provenance check'));
    const { deps, updater, reports } = setup({ stage });
    updater.target('1.1.0');
    await vi.advanceTimersByTimeAsync(POLL * 5);
    expect(reports.at(-1)).toEqual({
      version: '1.1.0',
      state: 'failed',
      reason: 'failed its provenance check',
    });
    expect(deps.activate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(RETRY);
    expect(stage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(POLL * 2);
    expect(deps.activate).toHaveBeenCalledOnce();
  });

  it('reports a failed swap and doesn’t restart', async () => {
    const activate = vi.fn(() => {
      throw new Error('disk full');
    });
    const { deps, updater, reports } = setup({ activate });
    updater.target('1.1.0');
    await vi.advanceTimersByTimeAsync(POLL * 2);
    expect(reports.at(-1)).toMatchObject({ state: 'failed', reason: 'disk full' });
    expect(deps.restart).not.toHaveBeenCalled();
  });

  it('says where it stands again when the hub repeats itself, without starting over', async () => {
    const { deps, updater, reports, setBusy } = setup();
    setBusy(true);
    updater.target('1.1.0');
    await vi.advanceTimersByTimeAsync(0);
    const before = reports.length;
    updater.target('1.1.0');
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.stage).toHaveBeenCalledOnce();
    expect(reports.length).toBe(before + 1);
    expect(reports.at(-1)).toEqual(reports[before - 1]);
  });

  it('moves to a newer target, even one set while the last was installing', async () => {
    const { deps, updater } = setup();
    updater.target('1.1.0');
    updater.target('1.2.0');
    await vi.advanceTimersByTimeAsync(POLL * 2);
    expect(deps.activate).toHaveBeenCalledTimes(1);
    expect(deps.activate).toHaveBeenCalledWith('1.2.0');
  });

  it('finishes one install before starting the next: both would write the same files', async () => {
    const finish: (() => void)[] = [];
    let running = 0;
    let most = 0;
    const stage = vi.fn(async () => {
      most = Math.max(most, ++running);
      await new Promise<void>((resolve) => finish.push(resolve));
      running--;
    });
    const { deps, updater } = setup({ stage });
    updater.target('1.1.0');
    updater.target('1.2.0');
    updater.target('1.3.0');
    await vi.advanceTimersByTimeAsync(POLL * 5);
    expect(stage).toHaveBeenCalledTimes(1);

    finish.shift()!();
    await vi.advanceTimersByTimeAsync(POLL * 5);
    expect(stage).toHaveBeenCalledTimes(2);
    expect(stage).toHaveBeenLastCalledWith('1.3.0');
    expect(deps.activate).not.toHaveBeenCalled();

    finish.shift()!();
    await vi.advanceTimersByTimeAsync(POLL * 2);
    expect(most).toBe(1);
    expect(deps.activate).toHaveBeenCalledTimes(1);
    expect(deps.activate).toHaveBeenCalledWith('1.3.0');
  });

  it('drops an install the hub took back while it ran', async () => {
    let finish = () => undefined as void;
    const stage = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { deps, updater } = setup({ stage });
    updater.target('1.1.0');
    updater.target(undefined);
    finish();
    await vi.advanceTimersByTimeAsync(POLL * 5);
    expect(stage).toHaveBeenCalledOnce();
    expect(deps.activate).not.toHaveBeenCalled();
  });

  it('stops waiting, and stops retrying, when the hub names nothing any more', async () => {
    const stage = vi.fn(async () => Promise.reject(new Error('no')));
    const { updater } = setup({ stage });
    updater.target('1.1.0');
    await vi.advanceTimersByTimeAsync(0);
    updater.target(undefined);
    await vi.advanceTimersByTimeAsync(RETRY * 3);
    expect(stage).toHaveBeenCalledOnce();
  });

  it('stands down when the hub drops back to a version it needn’t move to', async () => {
    const { deps, updater, setBusy } = setup();
    setBusy(true);
    updater.target('1.1.0');
    await vi.advanceTimersByTimeAsync(POLL);
    updater.target('1.0.0');
    setBusy(false);
    await vi.advanceTimersByTimeAsync(POLL * 5);
    expect(deps.activate).not.toHaveBeenCalled();
  });

  it('stops for good when closed', async () => {
    const { deps, updater } = setup();
    updater.target('1.1.0');
    await vi.advanceTimersByTimeAsync(0);
    updater.close();
    await vi.advanceTimersByTimeAsync(POLL * 5);
    expect(deps.activate).not.toHaveBeenCalled();
  });
});
