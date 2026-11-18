import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Scout, ScoutItem, ScoutRun } from '@crystal-bridge/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CATCH_UP_AFTER_MS,
  DEFAULT_TIMEOUT_SECONDS,
  FAILURES_TO_PAUSE,
  RUNS_KEPT,
  createScouts,
  jitterOf,
  type CollectRequest,
  type CollectResult,
  type QuestStart,
  type Scouts,
} from './scouts.js';

const MINUTE = 60_000;
/** A Tuesday, 12:00 UTC. */
const NOON = Date.parse('2026-11-17T12:00:00Z');

interface Sent {
  scout: string;
  run: ScoutRun;
  items?: ScoutItem[];
}

/** A collector the test finishes by hand. */
interface Pending {
  request: CollectRequest;
  finish(result: CollectResult): void;
  stopped: boolean;
}

const ITEMS = { items: [{ id: 'a', title: 'First' }] };
const ok = (stdout: unknown = ITEMS, stderr = ''): CollectResult => ({
  kind: 'exited',
  code: 0,
  stdout: JSON.stringify(stdout),
  stderr,
});

describe('Scouts', () => {
  let home: string;
  let dir: string;
  let now: number;
  let lists: Scout[][];
  let sent: Sent[];
  let pending: Pending[];
  let scouts: Scouts | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'scouts-'));
    dir = join(home, 'scouts');
    mkdirSync(dir);
    now = NOON;
    lists = [];
    sent = [];
    pending = [];
  });

  afterEach(() => {
    scouts?.close();
    scouts = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      name: 'Quest Board',
      schedule: { cron: '*/15 * * * *', timezone: 'UTC' },
      collect: { command: ['./collect.sh'] },
      view: 'list',
      actions: { done: { kind: 'done', label: 'Done' } },
      ...overrides,
    };
  }

  function scoutFolder(id: string, json: unknown = manifest()): void {
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(join(dir, id, 'scout.json'), typeof json === 'string' ? json : JSON.stringify(json));
  }

  function make(env: Record<string, string> = { PATH: '/bin' }): Scouts {
    scouts = createScouts({
      dir,
      home,
      statePath: join(home, 'scouts-state.json'),
      env,
      now: () => now,
      collect: (request) => {
        let finish!: (result: CollectResult) => void;
        const result = new Promise<CollectResult>((resolve) => (finish = resolve));
        const entry: Pending = { request, finish, stopped: false };
        pending.push(entry);
        return {
          result,
          stop: () => {
            entry.stopped = true;
          },
        };
      },
      onScouts: (list) => lists.push(list),
      onRun: (scout, run, items) => sent.push({ scout, run, ...(items ? { items } : {}) }),
      log: () => {},
    });
    return scouts;
  }

  /** Finishes the oldest collector still running, and waits for its run to be sent. */
  async function finish(result: CollectResult): Promise<void> {
    const entry = pending.shift();
    if (!entry) throw new Error('no collector is running');
    entry.finish(result);
    await scouts!.idle();
  }

  const listed = (id = 'quest-board') => scouts!.list().find((scout) => scout.id === id);
  /** The first slot after `from` of `*\/15 * * * *`, with the Scout's jitter. */
  const slot = (from: number, id = 'quest-board') => Math.floor(from / (15 * MINUTE) + 1) * 15 * MINUTE + jitterOf(id);

  describe('finding Scouts', () => {
    it('lists each folder with a scout.json, by name, with when it runs next', async () => {
      scoutFolder('quest-board');
      scoutFolder('mail');
      make();
      await scouts!.tick();
      expect(scouts!.list().map((scout) => scout.id)).toEqual(['mail', 'quest-board']);
      expect(listed()).toMatchObject({ manifest: { name: 'Quest Board' }, nextRunAt: slot(NOON) });
      expect(lists).toHaveLength(1);
    });

    it('lists nothing when the folder is missing, and finds Scouts once it appears', async () => {
      rmSync(dir, { recursive: true });
      make();
      await scouts!.tick();
      expect(scouts!.list()).toEqual([]);
      scoutFolder('quest-board');
      await scouts!.tick();
      expect(listed()?.manifest).toBeDefined();
    });

    it('leaves out folders whose names are no Scout id, and files beside the folders', async () => {
      scoutFolder('Not Valid');
      scoutFolder('.hidden');
      writeFileSync(join(dir, 'README.md'), 'notes');
      make();
      await scouts!.tick();
      expect(scouts!.list()).toEqual([]);
    });

    it('says when a folder has no scout.json', async () => {
      mkdirSync(join(dir, 'half-made'));
      make();
      await scouts!.tick();
      expect(listed('half-made')).toEqual({ id: 'half-made', error: expect.stringMatching(/no scout\.json/) });
    });

    it('reports a scout.json that is not JSON, or not a Scout', async () => {
      scoutFolder('broken', '{ nope');
      scoutFolder('wrong', manifest({ view: 'gallery' }));
      make();
      await scouts!.tick();
      expect(listed('broken')).toEqual({ id: 'broken', error: expect.stringMatching(/isn't JSON/) });
      expect(listed('wrong')).toEqual({ id: 'wrong', error: expect.stringMatching(/^scout\.json: view/) });
    });

    it('refuses a schedule that names no real time zone, or never comes round', async () => {
      scoutFolder('nowhere', manifest({ schedule: { cron: '0 9 * * *', timezone: 'Nowhere/Land' } }));
      scoutFolder('never', manifest({ schedule: { cron: '0 0 31 2 *', timezone: 'UTC' } }));
      scoutFolder('garbled', manifest({ schedule: { cron: '0 99 * * *', timezone: 'UTC' } }));
      make();
      await scouts!.tick();
      expect(listed('nowhere')?.error).toMatch(/time zone/);
      expect(listed('never')?.error).toMatch(/never/);
      expect(listed('garbled')?.error).toMatch(/schedule/);
    });

    it('keeps the last good scout.json beside the error, and drops the error once it is fixed', async () => {
      scoutFolder('quest-board');
      make();
      await scouts!.tick();
      scoutFolder('quest-board', '{ half an edit');
      await scouts!.tick();
      expect(listed()).toMatchObject({ manifest: { name: 'Quest Board' }, error: expect.stringMatching(/JSON/) });
      scoutFolder('quest-board', manifest({ name: 'Renamed' }));
      await scouts!.tick();
      expect(listed()?.manifest?.name).toBe('Renamed');
      expect(listed()?.error).toBeUndefined();
    });

    it('drops a Scout whose folder was removed', async () => {
      scoutFolder('quest-board');
      make();
      await scouts!.tick();
      rmSync(join(dir, 'quest-board'), { recursive: true });
      await scouts!.tick();
      expect(scouts!.list()).toEqual([]);
    });

    it('tells the hub only when the list changed', async () => {
      scoutFolder('quest-board');
      make();
      await scouts!.tick();
      await scouts!.tick();
      expect(lists).toHaveLength(1);
      scoutFolder('quest-board', manifest({ name: 'Renamed' }));
      await scouts!.tick();
      expect(lists).toHaveLength(2);
    });

    it('works out the next run again when the schedule changes', async () => {
      scoutFolder('quest-board');
      make();
      await scouts!.tick();
      scoutFolder('quest-board', manifest({ schedule: { cron: '0 18 * * *', timezone: 'America/Chicago' } }));
      await scouts!.tick();
      // 18:00 in Chicago in November is 00:00 UTC the next day.
      expect(listed()?.nextRunAt).toBe(Date.parse('2026-11-18T00:00:00Z') + jitterOf('quest-board'));
    });
  });

  describe('the schedule', () => {
    it('gives each Scout its own fixed jitter, under half a minute', () => {
      expect(jitterOf('quest-board')).toBe(jitterOf('quest-board'));
      expect(jitterOf('quest-board')).not.toBe(jitterOf('mail'));
      for (const id of ['a', 'quest-board', 'mail', 'x'.repeat(64)]) {
        expect(jitterOf(id)).toBeGreaterThanOrEqual(0);
        expect(jitterOf(id)).toBeLessThan(30_000);
      }
    });

    it('runs the collector at its time, not before, and sends the whole list', async () => {
      scoutFolder('quest-board');
      make();
      await scouts!.tick();
      const due = slot(NOON);
      now = due - 1;
      await scouts!.tick();
      expect(pending).toHaveLength(0);
      now = due;
      await scouts!.tick();
      expect(pending).toHaveLength(1);
      now = due + 2_000;
      await finish(ok());
      expect(sent).toEqual([
        {
          scout: 'quest-board',
          run: {
            id: expect.any(String),
            startedAt: due,
            finishedAt: due + 2_000,
            trigger: 'schedule',
            outcome: 'succeeded',
            items: 1,
          },
          items: ITEMS.items,
        },
      ]);
      expect(listed()?.nextRunAt).toBe(slot(due));
    });

    it('runs once on waking from a sleep that missed several runs, and marks it a catch-up', async () => {
      scoutFolder('quest-board');
      make();
      await scouts!.tick();
      now = NOON + 3 * 60 * MINUTE;
      await scouts!.tick();
      await scouts!.tick();
      expect(pending).toHaveLength(1);
      await finish(ok());
      expect(sent[0]?.run.trigger).toBe('catch-up');
      expect(listed()?.nextRunAt).toBe(slot(now));
    });

    it('counts a tick that is only a little late as on time', async () => {
      scoutFolder('quest-board');
      make();
      await scouts!.tick();
      now = slot(NOON) + CATCH_UP_AFTER_MS;
      await scouts!.tick();
      await finish(ok());
      expect(sent[0]?.run.trigger).toBe('schedule');
    });

    it('catches up once after a restart that missed a run', async () => {
      scoutFolder('quest-board');
      make();
      await scouts!.tick();
      scouts!.close();
      now = NOON + 60 * MINUTE;
      make();
      await scouts!.tick();
      expect(pending).toHaveLength(1);
      await finish(ok());
      expect(sent[0]?.run.trigger).toBe('catch-up');
    });

    it('does not run a new Scout at once: it waits for its first time', async () => {
      now = NOON + 7 * MINUTE;
      scoutFolder('quest-board');
      make();
      await scouts!.tick();
      expect(pending).toHaveLength(0);
      expect(listed()?.nextRunAt).toBe(slot(now));
    });

    it('skips a run that falls due while the last is still going, and records the skip', async () => {
      scoutFolder('quest-board', manifest({ schedule: { cron: '* * * * *', timezone: 'UTC' } }));
      make();
      await scouts!.tick();
      now += 2 * MINUTE;
      await scouts!.tick();
      expect(pending).toHaveLength(1);
      now += 2 * MINUTE;
      await scouts!.tick();
      expect(pending).toHaveLength(1);
      expect(sent).toEqual([
        {
          scout: 'quest-board',
          run: expect.objectContaining({ outcome: 'skipped', reason: expect.stringMatching(/still running/) }),
        },
      ]);
      expect(sent[0]?.run.finishedAt).toBe(now);
    });

    it('pauses after three failures in a row, until it is run by hand and works', async () => {
      scoutFolder('quest-board');
      make();
      await scouts!.tick();
      for (let i = 0; i < FAILURES_TO_PAUSE; i++) {
        now = listed()!.nextRunAt!;
        await scouts!.tick();
        await finish({ kind: 'exited', code: 1, stdout: '', stderr: 'gh: not logged in' });
      }
      expect(listed()?.paused).toMatch(/3 failed runs in a row/);
      expect(listed()?.nextRunAt).toBeUndefined();
      now += 60 * MINUTE;
      await scouts!.tick();
      expect(pending).toHaveLength(0);

      scouts!.runNow('quest-board');
      await finish({ kind: 'exited', code: 1, stdout: '', stderr: 'still not' });
      expect(listed()?.paused).toBeDefined();
      scouts!.runNow('quest-board');
      await finish(ok());
      expect(sent.at(-1)?.run.trigger).toBe('now');
      expect(listed()?.paused).toBeUndefined();
      expect(listed()?.nextRunAt).toBe(slot(now));
    });

    it('stays paused across a restart', async () => {
      scoutFolder('quest-board');
      make();
      await scouts!.tick();
      for (let i = 0; i < FAILURES_TO_PAUSE; i++) {
        now = listed()!.nextRunAt!;
        await scouts!.tick();
        await finish({ kind: 'timed-out', stderr: '' });
      }
      scouts!.close();
      make();
      await scouts!.tick();
      expect(listed()?.paused).toBeDefined();
    });

    it('a skip neither counts as a failure nor clears one', async () => {
      scoutFolder('quest-board');
      make();
      await scouts!.tick();
      now = listed()!.nextRunAt!;
      await scouts!.tick();
      await finish({ kind: 'exited', code: 2, stdout: '', stderr: '' });
      now = listed()!.nextRunAt!;
      await scouts!.tick();
      scouts!.runNow('quest-board');
      expect(sent.at(-1)?.run.outcome).toBe('skipped');
      await finish({ kind: 'exited', code: 2, stdout: '', stderr: '' });
      // Two failures: a skip counted as one would have paused it here.
      expect(listed()?.paused).toBeUndefined();
      scouts!.runNow('quest-board');
      await finish({ kind: 'exited', code: 2, stdout: '', stderr: '' });
      // The third: a skip that cleared the count would have left it running.
      expect(listed()?.paused).toBeDefined();
    });

    it('still counts failures from a state file someone edited badly', async () => {
      scoutFolder('quest-board');
      writeFileSync(
        join(home, 'scouts-state.json'),
        JSON.stringify({ 'quest-board': { schedule: '*/15 * * * *|UTC', failures: 'x', next: 'soon' } }),
      );
      make();
      await scouts!.tick();
      expect(listed()?.nextRunAt).toBe(slot(NOON));
      for (let i = 0; i < FAILURES_TO_PAUSE; i++) {
        scouts!.runNow('quest-board');
        await finish({ kind: 'exited', code: 1, stdout: '', stderr: '' });
      }
      expect(listed()?.paused).toBeDefined();
    });

    it('keeps a pause through a restart while its scout.json does not load', async () => {
      scoutFolder('quest-board');
      make();
      await scouts!.tick();
      for (let i = 0; i < FAILURES_TO_PAUSE; i++) {
        scouts!.runNow('quest-board');
        await finish({ kind: 'exited', code: 1, stdout: '', stderr: '' });
      }
      scouts!.close();
      scoutFolder('quest-board', '{ mid-edit');
      make();
      await scouts!.tick();
      scoutFolder('quest-board');
      await scouts!.tick();
      expect(listed()?.paused).toBeDefined();
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'keeps every Scout and its state when the folder can’t be read for a moment',
      async () => {
        scoutFolder('quest-board');
        make();
        await scouts!.tick();
        for (let i = 0; i < FAILURES_TO_PAUSE; i++) {
          scouts!.runNow('quest-board');
          await finish({ kind: 'exited', code: 1, stdout: '', stderr: '' });
        }
        const before = lists.length;
        chmodSync(dir, 0o000);
        try {
          await scouts!.tick();
        } finally {
          chmodSync(dir, 0o755);
        }
        expect(lists).toHaveLength(before);
        expect(listed()?.paused).toBeDefined();
        expect(scouts!.recent()).toHaveLength(FAILURES_TO_PAUSE);
      },
    );
  });

  describe('Run now', () => {
    it('runs a Scout at once, marked as asked for', async () => {
      scoutFolder('quest-board');
      make();
      await scouts!.tick();
      scouts!.runNow('quest-board');
      await finish(ok());
      expect(sent[0]?.run).toMatchObject({ trigger: 'now', outcome: 'succeeded', startedAt: NOON });
    });

    it('records a skip when the Scout is already running', async () => {
      scoutFolder('quest-board');
      make();
      await scouts!.tick();
      scouts!.runNow('quest-board');
      scouts!.runNow('quest-board');
      expect(pending).toHaveLength(1);
      expect(sent[0]?.run).toMatchObject({ trigger: 'now', outcome: 'skipped' });
    });

    it('records a failure for a Scout whose scout.json never loaded, so the Board says why', async () => {
      scoutFolder('broken', '{');
      make();
      await scouts!.tick();
      scouts!.runNow('broken');
      expect(pending).toHaveLength(0);
      expect(sent[0]?.run).toMatchObject({ trigger: 'now', outcome: 'failed', reason: expect.stringMatching(/JSON/) });
    });

    it('ignores a Scout it does not have', async () => {
      make();
      await scouts!.tick();
      scouts!.runNow('elsewhere');
      expect(pending).toHaveLength(0);
      expect(sent).toEqual([]);
    });
  });

  describe('running the collector', () => {
    it('runs the command in the Scout’s folder with its state folder, its timeout and no node token', async () => {
      scoutFolder('quest-board', manifest({ collect: { command: ['./collect.sh', '--all'], timeoutSeconds: 30 } }));
      make({ PATH: '/bin', CRYSTAL_TOKEN: 'secret', HOME: home });
      await scouts!.tick();
      scouts!.runNow('quest-board');
      const { request } = pending[0]!;
      expect(request).toEqual({
        cwd: join(dir, 'quest-board'),
        command: ['./collect.sh', '--all'],
        timeoutMs: 30_000,
        env: {
          PATH: '/bin',
          HOME: home,
          CRYSTAL_SCOUT: 'quest-board',
          CRYSTAL_SCOUT_STATE: join(dir, 'quest-board', 'state'),
        },
      });
      expect(existsSync(join(dir, 'quest-board', 'state'))).toBe(true);
    });

    it('gives a collector two minutes unless scout.json says otherwise', async () => {
      scoutFolder('quest-board');
      make();
      await scouts!.tick();
      scouts!.runNow('quest-board');
      expect(pending[0]?.request.timeoutMs).toBe(DEFAULT_TIMEOUT_SECONDS * 1000);
    });

    it('keeps the end of stderr, on success and failure alike', async () => {
      scoutFolder('quest-board');
      make();
      await scouts!.tick();
      scouts!.runNow('quest-board');
      await finish(ok(ITEMS, 'x'.repeat(10_000) + 'the end\n'));
      const { stderr } = sent[0]!.run;
      expect(stderr?.endsWith('the end\n')).toBe(true);
      expect(stderr?.length).toBe(8000);
    });

    it.each([
      [{ kind: 'exited', code: 3, stdout: '', stderr: '' }, 'failed', /exited with code 3/],
      [{ kind: 'exited', code: null, signal: 'SIGKILL', stdout: '', stderr: '' }, 'failed', /SIGKILL/],
      [{ kind: 'timed-out', stderr: '' }, 'timed-out', /30 s/],
      [{ kind: 'not-started', message: 'spawn ./collect.sh ENOENT' }, 'failed', /could not start.*ENOENT/],
      [{ kind: 'too-much', stderr: '' }, 'failed', /more than/],
      [{ kind: 'exited', code: 0, stdout: 'Fetching...\n', stderr: '' }, 'failed', /isn't JSON/],
      [{ kind: 'exited', code: 0, stdout: '{"items":[{"id":"a"}]}', stderr: '' }, 'failed', /items\.0\.title/],
    ] as const)('marks a bad run and sends no list: %j', async (result, outcome, reason) => {
      scoutFolder('quest-board', manifest({ collect: { command: ['./collect.sh'], timeoutSeconds: 30 } }));
      make();
      await scouts!.tick();
      scouts!.runNow('quest-board');
      await finish(result as CollectResult);
      expect(sent[0]?.run).toMatchObject({ outcome, reason: expect.stringMatching(reason) });
      expect(sent[0]?.items).toBeUndefined();
    });

    it('stops collectors that are still running when it closes, waits for them, and sends nothing for them', async () => {
      scoutFolder('quest-board');
      make();
      await scouts!.tick();
      scouts!.runNow('quest-board');
      let closed = false;
      const closing = scouts!.close().then(() => (closed = true));
      expect(pending[0]?.stopped).toBe(true);
      await Promise.resolve();
      expect(closed).toBe(false);
      await finish(ok());
      await closing;
      expect(sent).toEqual([]);
    });

    it('keeps a reason short enough for the hub, however long the command', async () => {
      scoutFolder('quest-board');
      make();
      await scouts!.tick();
      scouts!.runNow('quest-board');
      await finish({ kind: 'not-started', message: `spawn ${'x'.repeat(4000)} ENOENT` });
      expect(sent[0]?.run.reason?.length).toBeLessThanOrEqual(2000);
    });

    it.skipIf(process.platform === 'win32')('makes the state folder private to the Kingdom’s user', async () => {
      scoutFolder('quest-board');
      make();
      await scouts!.tick();
      scouts!.runNow('quest-board');
      expect(statSync(join(dir, 'quest-board', 'state')).mode & 0o777).toBe(0o700);
    });
  });

  describe('runs to resend after a reconnect', () => {
    it('keeps each Scout’s latest runs, oldest first', async () => {
      scoutFolder('quest-board');
      make();
      await scouts!.tick();
      for (let i = 0; i < RUNS_KEPT + 2; i++) {
        now += MINUTE;
        scouts!.runNow('quest-board');
        await finish(ok());
      }
      const recent = scouts!.recent();
      expect(recent).toHaveLength(RUNS_KEPT);
      expect(recent.map((frame) => frame.run.id)).toEqual(sent.slice(-RUNS_KEPT).map((frame) => frame.run.id));
      expect(recent[0]).toMatchObject({ kind: 'scout-run', scout: 'quest-board', items: ITEMS.items });
    });

    it('keeps the latest list even after more failures and skips than it keeps runs', async () => {
      scoutFolder('quest-board');
      make();
      await scouts!.tick();
      scouts!.runNow('quest-board');
      await finish(ok());
      const listed = sent[0]!.run.id;
      for (let i = 0; i < RUNS_KEPT + 1; i++) {
        scouts!.runNow('quest-board');
        scouts!.runNow('quest-board');
        await finish({ kind: 'exited', code: 1, stdout: '', stderr: '' });
      }
      const recent = scouts!.recent();
      expect(recent[0]).toMatchObject({ run: { id: listed }, items: ITEMS.items });
      expect(recent).toHaveLength(RUNS_KEPT + 1);
    });

    it('forgets the runs of a Scout that is gone', async () => {
      scoutFolder('quest-board');
      make();
      await scouts!.tick();
      scouts!.runNow('quest-board');
      await finish(ok());
      rmSync(join(dir, 'quest-board'), { recursive: true });
      await scouts!.tick();
      expect(scouts!.recent()).toEqual([]);
    });
  });

  describe('the synthesis step', () => {
    const PRS = {
      items: [
        { id: 'pr:12', title: 'Fix the retry loop', actions: ['fix', 'done'] },
        { id: 'pr:15', title: 'Bump a test dependency', actions: ['merge', 'done'] },
        { id: 'pr:16', title: 'Draft: rework settings page' },
      ],
    };
    const recorded = readFileSync(join(import.meta.dirname, '..', 'test', 'fixtures', 'synthesis.ndjson'), 'utf8');
    const answered = (stdout = recorded, code = 0): CollectResult => ({ kind: 'exited', code, stdout, stderr: '' });
    const synthesizing = (overrides: Record<string, unknown> = {}) =>
      manifest({
        synthesize: { prompt: 'synthesize.md', ...overrides },
        actions: {
          fix: { kind: 'run', label: 'Fix', command: ['./fix.sh'] },
          merge: { kind: 'run', label: 'Merge', command: ['./merge.sh'] },
          done: { kind: 'done', label: 'Done' },
        },
        defaults: ['done'],
      });

    /** Finishes the collector, then the synthesis call it leads to, and waits for the run. */
    async function collectThenSynthesize(list: unknown, synthesis: CollectResult = answered()): Promise<void> {
      pending.shift()!.finish(ok(list));
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      await finish(synthesis);
    }

    async function ready(json = synthesizing(), env?: Record<string, string>): Promise<void> {
      scoutFolder('quest-board', json);
      writeFileSync(join(dir, 'quest-board', 'synthesize.md'), 'Rank what needs me first.\n');
      make(env);
      await scouts!.tick();
    }

    it('asks the Kingdom-s own claude, with no tools and a budget cap, and the list on stdin', async () => {
      await ready(synthesizing(), { PATH: '/bin', CRYSTAL_TOKEN: 'secret' });
      scouts!.runNow('quest-board');
      pending.shift()!.finish(ok(PRS));
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      const { request } = pending[0]!;
      expect(request.cwd).toBe(join(dir, 'quest-board'));
      expect(request.command.slice(0, 2)).toEqual(['claude', '-p']);
      expect(request.command.slice(-2)).toEqual(['--tools', '']);
      expect(request.command[request.command.indexOf('--max-budget-usd') + 1]).toBe('0.5');
      expect(request.command).not.toContain('--bare');
      expect(request.env).not.toHaveProperty('CRYSTAL_TOKEN');
      expect(request.stdin?.startsWith('Rank what needs me first.')).toBe(true);
      expect(request.stdin).toContain('"id":"pr:12"');
      await finish(answered());
    });

    it('sends the list ranked and summed up, with what it cost', async () => {
      await ready();
      scouts!.runNow('quest-board');
      await collectThenSynthesize(PRS);
      const { run, items } = sent[0]!;
      expect(run).toMatchObject({ outcome: 'succeeded', items: 3 });
      expect(run.costUsd).toBeCloseTo(0.043272);
      expect(items?.map((item) => [item.id, item.rank, item.suggested])).toEqual([
        ['pr:12', 1, 'fix'],
        ['pr:15', 2, 'merge'],
        ['pr:16', 3, undefined],
      ]);
      expect(items?.[0]?.summary).toMatch(/retry/);
    });

    it('runs only when the list changed, applying the last answer again in between', async () => {
      await ready();
      scouts!.runNow('quest-board');
      await collectThenSynthesize(PRS);
      scouts!.runNow('quest-board');
      await finish(ok({ items: [...PRS.items].reverse() }));
      expect(pending).toHaveLength(0);
      expect(sent[1]!.run.costUsd).toBeUndefined();
      expect(sent[1]!.items?.find((item) => item.id === 'pr:12')?.rank).toBe(1);

      scouts!.runNow('quest-board');
      await collectThenSynthesize({ items: PRS.items.slice(1) });
      expect(sent[2]!.run.costUsd).toBeCloseTo(0.043272);
    });

    it('keeps the plain list when the synthesis fails, and says why', async () => {
      await ready();
      scouts!.runNow('quest-board');
      const over = JSON.stringify({
        type: 'result',
        subtype: 'error_max_budget_usd',
        is_error: true,
        total_cost_usd: 0.5,
      });
      await collectThenSynthesize(PRS, answered(over, 1));
      expect(sent[0]!.run).toMatchObject({
        outcome: 'succeeded',
        costUsd: 0.5,
        reason: expect.stringMatching(/budget/),
      });
      expect(sent[0]!.items?.every((item) => item.rank === undefined)).toBe(true);
    });

    it.each([
      [{ kind: 'not-started', message: 'spawn claude ENOENT' }, /could not start claude.*ENOENT/],
      [{ kind: 'timed-out', stderr: '' }, /stopped after/],
      [{ kind: 'exited', code: 1, stdout: '', stderr: 'Not logged in' }, /exited with code 1.*Not logged in/],
      [{ kind: 'exited', code: null, signal: 'SIGKILL', stdout: '', stderr: '' }, /killed by SIGKILL/],
      [{ kind: 'exited', code: 0, stdout: '', stderr: '' }, /printed no result/],
      [{ kind: 'too-much', stderr: '' }, /more than 4 MB/],
    ] as [CollectResult, RegExp][])('says why when claude itself fails (%o)', async (result, why) => {
      await ready();
      scouts!.runNow('quest-board');
      await collectThenSynthesize(PRS, result);
      expect(sent[0]!.run).toMatchObject({ outcome: 'succeeded', items: 3, reason: expect.stringMatching(why) });
    });

    it('says so when the prompt file can-t be read, and never calls claude', async () => {
      scoutFolder('quest-board', synthesizing());
      make();
      await scouts!.tick();
      scouts!.runNow('quest-board');
      await finish(ok(PRS));
      expect(pending).toHaveLength(0);
      expect(sent[0]!.run).toMatchObject({ outcome: 'succeeded', reason: expect.stringMatching(/synthesize\.md/) });
    });

    it('takes the Scout-s budget cap and the Kingdom-s CLAUDE_BIN', async () => {
      await ready(synthesizing({ maxBudgetUsd: 0.2 }), { PATH: '/bin', CLAUDE_BIN: '/opt/claude' });
      scouts!.runNow('quest-board');
      pending.shift()!.finish(ok(PRS));
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      const { command } = pending[0]!.request;
      expect(command[0]).toBe('/opt/claude');
      expect(command[command.indexOf('--max-budget-usd') + 1]).toBe('0.2');
      await finish(answered());
    });

    it('counts as running while it thinks, so Run now records a skip', async () => {
      await ready();
      scouts!.runNow('quest-board');
      pending.shift()!.finish(ok(PRS));
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      scouts!.runNow('quest-board');
      expect(sent[0]!.run.outcome).toBe('skipped');
      await finish(answered());
      expect(sent[1]!.run.outcome).toBe('succeeded');
    });

    it('never calls claude for an empty list', async () => {
      await ready();
      scouts!.runNow('quest-board');
      await finish(ok({ items: [] }));
      expect(pending).toHaveLength(0);
      expect(sent[0]!.run).toMatchObject({ outcome: 'succeeded', items: 0 });
      expect(sent[0]!.run.reason).toBeUndefined();
    });

    it('runs again when synthesize.md changes, though the list did not', async () => {
      await ready();
      scouts!.runNow('quest-board');
      await collectThenSynthesize(PRS);
      writeFileSync(join(dir, 'quest-board', 'synthesize.md'), 'Rank by age instead.\n');
      scouts!.runNow('quest-board');
      await collectThenSynthesize(PRS);
      expect(sent[1]!.run.costUsd).toBeCloseTo(0.043272);
    });

    it('says why on every run while a failure stands, and Run now tries again', async () => {
      await ready();
      now = slot(now);
      await scouts!.tick();
      const out = JSON.stringify({
        type: 'result',
        subtype: 'error_max_budget_usd',
        is_error: true,
        total_cost_usd: 0.5,
      });
      await collectThenSynthesize(PRS, answered(out, 1));
      expect(sent[0]!.run.reason).toBe('not synthesized: it reached its budget cap (synthesize.maxBudgetUsd)');

      // A scheduled run with the same list repeats the reason and makes no call.
      now = slot(now);
      await scouts!.tick();
      await finish(ok(PRS));
      expect(pending).toHaveLength(0);
      expect(sent[1]!.run).toMatchObject({ trigger: 'schedule', reason: sent[0]!.run.reason });
      expect(sent[1]!.run.costUsd).toBeUndefined();

      // Run now tries again, say once the cap was raised.
      scouts!.runNow('quest-board');
      await collectThenSynthesize(PRS);
      expect(sent[2]!.run.reason).toBeUndefined();
      expect(sent[2]!.items?.[0]?.rank).toBe(1);
    });

    it('runs again when scout.json changes what the step sees, such as its budget cap', async () => {
      await ready();
      scouts!.runNow('quest-board');
      await collectThenSynthesize(PRS);
      writeFileSync(join(dir, 'quest-board', 'scout.json'), JSON.stringify(synthesizing({ maxBudgetUsd: 1 })));
      now = slot(now);
      await scouts!.tick();
      await collectThenSynthesize(PRS);
      expect(sent[1]!.run).toMatchObject({ trigger: 'schedule' });
      expect(sent[1]!.run.costUsd).toBeCloseTo(0.043272);
    });

    it('runs again when the Scout is renamed, since its prompt names it', async () => {
      await ready();
      scouts!.runNow('quest-board');
      await collectThenSynthesize(PRS);
      writeFileSync(
        join(dir, 'quest-board', 'scout.json'),
        JSON.stringify({ ...synthesizing(), name: 'Pull requests' }),
      );
      now = slot(now);
      await scouts!.tick();
      await collectThenSynthesize(PRS);
      expect(sent[1]!.run.costUsd).toBeCloseTo(0.043272);
    });

    it('reads a missing synthesize.md again on the next scheduled run', async () => {
      scoutFolder('quest-board', synthesizing());
      make();
      await scouts!.tick();
      scouts!.runNow('quest-board');
      await finish(ok(PRS));
      expect(sent[0]!.run.reason).toBe("not synthesized: can't read synthesize.md in the Scout's folder");
      writeFileSync(join(dir, 'quest-board', 'synthesize.md'), 'Rank.\n');
      now = slot(now);
      await scouts!.tick();
      await collectThenSynthesize(PRS);
      expect(sent[1]!.run.reason).toBeUndefined();
      expect(sent[1]!.items?.[0]?.rank).toBe(1);
    });

    it('tries a failed step again on schedule once the list changes', async () => {
      await ready();
      scouts!.runNow('quest-board');
      await collectThenSynthesize(PRS, { kind: 'timed-out', stderr: '' });
      now = slot(now);
      await scouts!.tick();
      await collectThenSynthesize({ items: PRS.items.slice(1) });
      expect(sent[1]!.run.reason).toBeUndefined();
      expect(sent[1]!.run.costUsd).toBeCloseTo(0.043272);
    });

    it('stops claude on close, and reports nothing', async () => {
      await ready();
      scouts!.runNow('quest-board');
      pending.shift()!.finish(ok(PRS));
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      const synthesis = pending[0]!;
      const closing = scouts!.close();
      expect(synthesis.stopped).toBe(true);
      synthesis.finish({ kind: 'exited', code: null, signal: 'SIGTERM', stdout: '', stderr: '' });
      await closing;
      scouts = undefined;
      expect(sent).toHaveLength(0);
    });
  });

  describe('actions', () => {
    const REQUEST = '22222222-2222-4222-8222-222222222222';
    const pr: ScoutItem = {
      id: 'github:pr:owner/repo#1',
      title: 'Fix the retry loop',
      fields: { checkout: '~/code/repo' },
      actions: ['fix', 'archive', 'tidy', 'done'],
    };
    const other: ScoutItem = { ...pr, id: 'github:pr:owner/repo#2', title: 'Second' };
    let started: QuestStart[];
    const startQuest = async (start: QuestStart) => {
      started.push(start);
      return { ok: true as const, session: '33333333-3333-4333-8333-333333333333' };
    };
    const action = (name: string, items: ScoutItem[] = [pr]) => ({
      kind: 'scout-action' as const,
      requestId: REQUEST,
      scout: 'quest-board',
      action: name,
      items,
    });

    beforeEach(async () => {
      started = [];
      mkdirSync(join(home, 'code', 'repo'), { recursive: true });
      scoutFolder(
        'quest-board',
        manifest({
          actions: {
            fix: {
              kind: 'quest',
              label: 'Fix it',
              project: '{{fields.checkout}}',
              prompt: 'fix.md',
              mode: 'auto',
              worktree: true,
            },
            escape: { kind: 'quest', label: 'Escape', project: '~', prompt: '../../secret.md' },
            archive: { kind: 'run', label: 'Archive', command: ['./act.sh', 'archive'], batch: true, then: 'done' },
            tidy: { kind: 'run', label: 'Tidy', command: ['./act.sh', 'tidy'] },
            done: { kind: 'done', label: 'Done' },
          },
        }),
      );
      writeFileSync(join(dir, 'quest-board', 'fix.md'), 'Fix the failing check, then push.\n');
      make();
      await scouts!.tick();
    });

    it('starts a Quest in the filled project, with the template apart from the untrusted item', async () => {
      const answer = await scouts!.act(action('fix'), startQuest);
      expect(answer).toEqual({ ok: true, session: '33333333-3333-4333-8333-333333333333' });
      expect(started).toHaveLength(1);
      const [start] = started;
      expect(start).toMatchObject({
        cwd: join(home, 'code', 'repo'),
        mode: 'auto',
        worktree: true,
        from: { scout: 'quest-board', item: pr.id, title: pr.title },
      });
      expect(start!.prompt.startsWith('Fix the failing check, then push.')).toBe(true);
      expect(start!.prompt).toContain('<untrusted-item>');
    });

    it('passes on why a Quest could not start', async () => {
      const answer = await scouts!.act(action('fix'), async () => ({ ok: false, reason: 'no worktree' }));
      expect(answer).toEqual({ ok: false, reason: 'no worktree' });
    });

    it('starts one Quest per press: never for several items at once', async () => {
      const answer = await scouts!.act(action('fix', [pr, other]), startQuest);
      expect(answer.ok).toBe(false);
      expect(started).toEqual([]);
    });

    it('refuses a prompt file outside the Scout’s folder, a missing one, and a project that is no folder', async () => {
      writeFileSync(join(home, 'secret.md'), 'secret');
      expect(await scouts!.act(action('escape', [{ ...pr, actions: ['escape'] }]), startQuest)).toMatchObject({
        ok: false,
      });
      rmSync(join(dir, 'quest-board', 'fix.md'));
      expect(await scouts!.act(action('fix'), startQuest)).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/fix\.md/),
      });
      writeFileSync(join(dir, 'quest-board', 'fix.md'), 'Fix it.');
      const elsewhere = { ...pr, fields: { checkout: '~/code/missing' } };
      expect(await scouts!.act(action('fix', [elsewhere]), startQuest)).toMatchObject({ ok: false });
      expect(started).toEqual([]);
    });

    it('refuses an action the item does not offer, one the Scout does not declare, and one the hub carries out', async () => {
      const bare = { ...pr, actions: ['done'] };
      expect(await scouts!.act(action('fix', [bare]), startQuest)).toMatchObject({ ok: false });
      expect(await scouts!.act(action('nope'), startQuest)).toMatchObject({ ok: false });
      expect(await scouts!.act(action('done'), startQuest)).toMatchObject({ ok: false });
      expect(await scouts!.act({ ...action('fix'), scout: 'elsewhere' }, startQuest)).toMatchObject({ ok: false });
      expect(started).toEqual([]);
      expect(pending).toEqual([]);
    });

    it('runs a script in the Scout’s folder with the items as JSON on stdin', async () => {
      const answer = scouts!.act(action('archive', [pr, other]), startQuest);
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      const { request } = pending[0]!;
      expect(request.cwd).toBe(join(dir, 'quest-board'));
      expect(request.command).toEqual(['./act.sh', 'archive']);
      expect(request.env).toMatchObject({ CRYSTAL_SCOUT: 'quest-board', CRYSTAL_SCOUT_ACTION: 'archive' });
      expect(JSON.parse(request.stdin!)).toEqual({ scout: 'quest-board', action: 'archive', items: [pr, other] });
      pending.shift()!.finish({ kind: 'exited', code: 0, stdout: '', stderr: '' });
      expect(await answer).toEqual({ ok: true });
    });

    it('says why a script failed, with the end of its stderr', async () => {
      const answer = scouts!.act(action('tidy'), startQuest);
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      pending.shift()!.finish({ kind: 'exited', code: 2, stdout: '', stderr: 'token expired' });
      const result = await answer;
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ reason: expect.stringMatching(/code 2[\s\S]*token expired/) });
    });

    it('makes the state folder a script is pointed at, even when no collector has run', async () => {
      rmSync(join(dir, 'quest-board', 'state'), { recursive: true, force: true });
      const answer = scouts!.act(action('tidy'), startQuest);
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      expect(statSync(join(dir, 'quest-board', 'state')).isDirectory()).toBe(true);
      pending.shift()!.finish({ kind: 'exited', code: 0, stdout: '', stderr: '' });
      await answer;
    });

    it('stops a running script on close, and takes no action after it', async () => {
      void scouts!.act(action('tidy'), startQuest);
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      const closing = scouts!.close();
      expect(pending[0]!.stopped).toBe(true);
      pending.shift()!.finish({ kind: 'exited', code: null, signal: 'SIGTERM', stdout: '', stderr: '' });
      await closing;
      expect(await scouts!.act(action('tidy'), startQuest)).toMatchObject({ ok: false });
      expect(pending).toEqual([]);
    });

    it('runs a script that takes one item at a time only on one item', async () => {
      expect(await scouts!.act(action('tidy', [pr, other]), startQuest)).toMatchObject({ ok: false });
      expect(pending).toEqual([]);
    });
  });
});
