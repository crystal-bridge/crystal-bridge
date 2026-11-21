import type { ListedPatrol, PatrolRun } from '@crystal-bridge/protocol';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubClient, PatrolsFrame } from './hub.js';
import {
  boardPatrols,
  changePatrol,
  markPatrolRun,
  patrolStanding,
  previewPatrol,
  runPatrolNow,
  savePatrol,
  untilText,
  usePatrols,
} from './patrols.js';

const RUN = '33333333-3333-4333-8333-333333333333';
const run = (extra: Partial<PatrolRun> = {}): PatrolRun => ({
  id: RUN,
  startedAt: 1,
  trigger: 'schedule',
  outcome: 'finished',
  ...extra,
});
const manifest = {
  name: 'Sweep',
  schedule: { cron: '0 9 * * 1', timezone: 'UTC' },
  quest: { project: '~/code/app', promptText: 'Sweep.' },
} as ListedPatrol['manifest'];
const patrol = (extra: Partial<ListedPatrol> = {}): ListedPatrol => ({ id: 'sweep', manifest, ...extra });

function fakeHub() {
  const listeners = new Set<(frame: PatrolsFrame) => void>();
  const reconnects = new Set<() => void>();
  const hub = {
    onPatrols(listener: (frame: PatrolsFrame) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onReconnect(listener: () => void) {
      reconnects.add(listener);
      return () => reconnects.delete(listener);
    },
  } as unknown as HubClient;
  return {
    hub,
    frame: (frame: PatrolsFrame) => listeners.forEach((listener) => listener(frame)),
    reconnect: () => reconnects.forEach((listener) => listener()),
  };
}

/** Each fetch waits until a test answers it, so the order of a reply and a frame is the test's. */
function fakeFetch() {
  const pending: { url: string; init?: RequestInit; answer: (body: unknown, status?: number) => void }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string, init?: RequestInit) =>
        new Promise((resolve) =>
          pending.push({
            url,
            ...(init ? { init } : {}),
            answer: (body, status = 200) =>
              resolve({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }),
          }),
        ),
    ),
  );
  return pending;
}

describe('usePatrols', () => {
  let pending: ReturnType<typeof fakeFetch>;
  beforeEach(() => {
    pending = fakeFetch();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('loads a Kingdom’s Patrols and each one’s runs, then takes its frames and ignores other Kingdoms’', async () => {
    const { hub, frame } = fakeHub();
    const { result } = renderHook(() => usePatrols(hub, 'forge'));
    expect(pending[0]!.url).toBe('/api/nodes/forge/patrols');
    act(() => pending[0]!.answer({ patrols: [patrol()], editable: true }));
    await waitFor(() => expect(pending[1]?.url).toBe('/api/nodes/forge/patrols/sweep'));
    act(() => pending[1]!.answer({ patrol: patrol(), runs: [run()] }));
    await waitFor(() => expect(result.current.runs.sweep).toEqual([run()]));
    expect(result.current).toMatchObject({ editable: true, loaded: true, patrols: [{ id: 'sweep' }] });

    act(() => frame({ kind: 'patrols', node: 'elsewhere', editable: false, patrols: [] }));
    act(() => frame({ kind: 'patrol-runs', node: 'elsewhere', patrol: 'sweep', runs: [] }));
    expect(result.current.patrols).toHaveLength(1);
    expect(result.current.runs.sweep).toHaveLength(1);

    const out = run({ outcome: 'running' });
    act(() => frame({ kind: 'patrol-runs', node: 'forge', patrol: 'sweep', runs: [out, run()] }));
    expect(result.current.runs.sweep).toEqual([out, run()]);
    act(() => frame({ kind: 'patrols', node: 'forge', editable: false, patrols: [patrol({ paused: 'by hand' })] }));
    expect(result.current).toMatchObject({ editable: false, patrols: [{ paused: 'by hand' }] });
  });

  it('keeps a list frame that lands while the list is on its way, and reads runs for a Patrol that appears', async () => {
    const { hub, frame } = fakeHub();
    const { result } = renderHook(() => usePatrols(hub, 'forge'));
    act(() => frame({ kind: 'patrols', node: 'forge', editable: true, patrols: [patrol({ failures: 2 })] }));
    act(() => pending[0]!.answer({ patrols: [patrol()], editable: true }));
    await act(async () => {});
    expect(result.current.patrols[0]!.failures).toBe(2);
    await waitFor(() => expect(pending.some((one) => one.url === '/api/nodes/forge/patrols/sweep')).toBe(true));
  });

  const reads = (url: string) => pending.filter((one) => one.url === url);
  const LIST = '/api/nodes/forge/patrols';
  const RUNS = '/api/nodes/forge/patrols/sweep';

  it('keeps a runs frame that lands while that Patrol’s own read is on its way', async () => {
    const { hub, frame } = fakeHub();
    const { result } = renderHook(() => usePatrols(hub, 'forge'));
    act(() => pending[0]!.answer({ patrols: [patrol()], editable: true }));
    await waitFor(() => expect(reads(RUNS)).toHaveLength(1));
    const out = run({ outcome: 'running' });
    act(() => frame({ kind: 'patrol-runs', node: 'forge', patrol: 'sweep', runs: [out] }));
    act(() => reads(RUNS)[0]!.answer({ patrol: patrol(), runs: [run()] }));
    await act(async () => {});
    expect(result.current.runs.sweep).toEqual([out]);
  });

  it('reads everything again when the socket comes back, and drops what the last round answers late', async () => {
    const { hub, reconnect } = fakeHub();
    const { result } = renderHook(() => usePatrols(hub, 'forge'));
    act(() => reads(LIST)[0]!.answer({ patrols: [patrol()], editable: true }));
    await waitFor(() => expect(reads(RUNS)).toHaveLength(1));
    act(() => reconnect());
    expect(reads(LIST)).toHaveLength(2);
    // The first round's runs read answers after the reconnect: it's stale.
    act(() => reads(RUNS)[0]!.answer({ patrol: patrol(), runs: [run({ outcome: 'failed' })] }));
    await act(async () => {});
    expect(result.current.runs.sweep).toBeUndefined();
    // The new round reads the Patrol's runs again.
    act(() => reads(LIST)[1]!.answer({ patrols: [patrol({ failures: 3 })], editable: true }));
    await waitFor(() => expect(reads(RUNS)).toHaveLength(2));
    act(() => reads(RUNS)[1]!.answer({ patrol: patrol(), runs: [run()] }));
    await waitFor(() => expect(result.current.runs.sweep).toEqual([run()]));
    expect(result.current.patrols[0]!.failures).toBe(3);
  });

  it('drops a list the last round answers late', async () => {
    const { hub, reconnect } = fakeHub();
    const { result } = renderHook(() => usePatrols(hub, 'forge'));
    act(() => reconnect());
    act(() => reads(LIST)[1]!.answer({ patrols: [patrol({ failures: 2 })], editable: true }));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => reads(LIST)[0]!.answer({ patrols: [], editable: false }));
    await act(async () => {});
    expect(result.current).toMatchObject({ editable: true, patrols: [{ failures: 2 }] });
  });

  it('reads a Patrol’s runs again after a read that failed, when the list comes again', async () => {
    const { hub, frame } = fakeHub();
    const { result } = renderHook(() => usePatrols(hub, 'forge'));
    act(() => reads(LIST)[0]!.answer({ patrols: [patrol()], editable: true }));
    await waitFor(() => expect(reads(RUNS)).toHaveLength(1));
    act(() => reads(RUNS)[0]!.answer({ error: 'no such Patrol on that Kingdom' }, 404));
    await act(async () => {});
    act(() => frame({ kind: 'patrols', node: 'forge', editable: true, patrols: [patrol()] }));
    await waitFor(() => expect(reads(RUNS)).toHaveLength(2));
    act(() => reads(RUNS)[1]!.answer({ patrol: patrol(), runs: [run()] }));
    await waitFor(() => expect(result.current.runs.sweep).toEqual([run()]));
  });

  it('starts empty on another Kingdom, and ignores what the last one answers late', async () => {
    const { hub } = fakeHub();
    const { result, rerender } = renderHook(({ node }) => usePatrols(hub, node), { initialProps: { node: 'forge' } });
    rerender({ node: 'tower' });
    expect(result.current).toMatchObject({ loaded: false, patrols: [] });
    expect(pending.at(-1)!.url).toBe('/api/nodes/tower/patrols');
    act(() => reads(LIST)[0]!.answer({ patrols: [patrol()], editable: true }));
    await act(async () => {});
    expect(result.current.patrols).toEqual([]);
  });
});

describe('patrolStanding', () => {
  it('puts what stops a Patrol first, then a run out or waiting, then failures', () => {
    expect(patrolStanding(patrol({ manifest: undefined, error: 'bad json' }), [])).toBe('broken');
    expect(patrolStanding(patrol({ paused: 'by hand' }), [run({ outcome: 'running' })])).toBe('stood-down');
    expect(patrolStanding(patrol({ failures: 1 }), [run({ outcome: 'running' })])).toBe('out');
    expect(patrolStanding(patrol(), [run({ outcome: 'needs-you' })])).toBe('waiting');
    expect(patrolStanding(patrol({ failures: 1 }), [run({ outcome: 'failed' })])).toBe('failing');
    expect(patrolStanding(patrol({ failures: 0 }), [run()])).toBe('on-watch');
    // A file that stopped loading still runs its last good one.
    expect(patrolStanding(patrol({ error: 'bad json' }), [])).toBe('on-watch');
  });

  it('falls back on the list’s last run before the runs are read', () => {
    expect(patrolStanding(patrol({ lastRun: run({ outcome: 'running' }) }), undefined)).toBe('out');
  });
});

describe('untilText', () => {
  it('says how long until a time, coarser as it gets further', () => {
    const now = 1_000_000;
    expect(untilText(now + 20 * 60_000, now)).toBe('in 20m');
    expect(untilText(now + 30_000, now)).toBe('in 1m');
    expect(untilText(now + (4 * 60 + 50) * 60_000, now)).toBe('in 4h 50m');
    expect(untilText(now + 3 * 86_400_000 + 3_600_000, now)).toBe('in 3d');
    expect(untilText(now - 1, now)).toBe('due now');
  });
});

describe('Patrol actions', () => {
  let pending: ReturnType<typeof fakeFetch>;
  beforeEach(() => {
    pending = fakeFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('asks the hub to run, pause, resume or delete a Patrol', async () => {
    const sent = [
      runPatrolNow('forge', 'sweep'),
      changePatrol('forge', 'sweep', 'pause'),
      changePatrol('forge', 'sweep', 'resume'),
      changePatrol('forge', 'sweep', 'delete'),
    ];
    expect(pending.map((one) => [one.init?.method, one.url])).toEqual([
      ['POST', '/api/nodes/forge/patrols/sweep/run'],
      ['POST', '/api/nodes/forge/patrols/sweep/pause'],
      ['POST', '/api/nodes/forge/patrols/sweep/resume'],
      ['DELETE', '/api/nodes/forge/patrols/sweep'],
    ]);
    for (const one of pending) one.answer({}, 202);
    await Promise.all(sent);
  });

  it('throws the hub’s reason when it refuses', async () => {
    const asking = changePatrol('forge', 'sweep', 'pause');
    pending[0]!.answer({ error: 'that Kingdom is offline' }, 404);
    await expect(asking).rejects.toThrow('that Kingdom is offline');
  });

  it('saves a Patrol with its manifest, and previews a schedule', async () => {
    const manifest = {
      name: 'Sweep',
      schedule: { cron: '0 9 * * *', timezone: 'UTC' },
      quest: { project: '~/code/app', promptText: 'Sweep.' },
    };
    const saving = savePatrol('forge', 'sweep', manifest);
    const previewing = previewPatrol('forge', manifest.schedule, new AbortController().signal);
    expect(pending.map((one) => [one.init?.method, one.url, JSON.parse(String(one.init?.body))])).toEqual([
      ['PUT', '/api/nodes/forge/patrols/sweep', { manifest }],
      ['POST', '/api/nodes/forge/patrol-preview', { schedule: manifest.schedule, count: 5 }],
    ]);
    pending[0]!.answer({}, 202);
    pending[1]!.answer({ times: [1, 2] }, 200);
    await saving;
    await expect(previewing).resolves.toEqual([1, 2]);
  });

  it('gives a preview’s refusal as the Kingdom’s reason', async () => {
    const previewing = previewPatrol('forge', { cron: '0 9 * * *', timezone: 'Nowhere' }, new AbortController().signal);
    pending[0]!.answer({ error: 'schedule: "Nowhere" is no time zone this machine knows' }, 400);
    await expect(previewing).rejects.toThrow('no time zone');
  });

  it('marks a run done, or not done again', async () => {
    const marking = markPatrolRun('forge', 'sweep', RUN, true);
    expect([pending[0]!.init?.method, pending[0]!.url, JSON.parse(String(pending[0]!.init?.body))]).toEqual([
      'POST',
      `/api/nodes/forge/patrols/sweep/runs/${RUN}/done`,
      { done: true },
    ]);
    pending[0]!.answer({ runs: [] }, 200);
    await marking;
  });
});

describe('boardPatrols', () => {
  const at = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const onBoard = (id: string, extra: Partial<ListedPatrol> = {}) =>
    patrol({ id, manifest: { ...manifest!, name: id, board: 'repo-watch' }, ...extra });

  it('picks the Patrols that post to this Board, and their reports newest first, without skips', () => {
    const state = {
      loaded: true,
      editable: false,
      patrols: [
        onBoard('sweep'),
        patrol({ id: 'elsewhere', manifest: { ...manifest!, board: 'other' }, lastRun: run({ id: at(9) }) }),
        onBoard('links', { lastRun: run({ id: at(5), startedAt: 50 }) }),
      ],
      runs: {
        sweep: [
          run({ id: at(3), startedAt: 30, outcome: 'skipped' }),
          run({ id: at(2), startedAt: 20 }),
          run({ id: at(1), startedAt: 10, outcome: 'failed' }),
        ],
        elsewhere: [run({ id: at(9), startedAt: 90 })],
      },
    };
    const picked = boardPatrols(state, 'repo-watch');
    expect(picked.patrols.map((one) => one.id)).toEqual(['sweep', 'links']);
    // A Patrol whose runs haven't loaded yet shows its latest run.
    expect(picked.reports.map(({ patrol, run }) => [patrol.id, run.id])).toEqual([
      ['links', at(5)],
      ['sweep', at(2)],
      ['sweep', at(1)],
    ]);
    expect(boardPatrols(state, 'repo-watch', 2).reports).toHaveLength(2);
    expect(boardPatrols(state, 'nobody')).toEqual({ patrols: [], reports: [] });
  });
});
