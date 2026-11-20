import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Patrol, PatrolRun } from '@crystal-bridge/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SCRIPT_TIMEOUT_SECONDS,
  FAILURES_TO_STAND_DOWN,
  createPatrols,
  type PatrolQuestStart,
  type Patrols,
} from './patrols.js';
import { jitterOf } from './scouts.js';
import type { CollectRequest, CollectResult } from './scouts.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** A Tuesday, 12:00 UTC. */
const NOON = Date.parse('2026-11-17T12:00:00Z');

interface Sent {
  patrol: string;
  run: PatrolRun;
}

interface Pending {
  request: CollectRequest;
  finish(result: CollectResult): void;
  stopped: boolean;
}

const exited = (code: number, stdout = '', stderr = ''): CollectResult => ({ kind: 'exited', code, stdout, stderr });

describe('Patrols', () => {
  let home: string;
  let dir: string;
  let now: number;
  let lists: Patrol[][];
  let sent: Sent[];
  let pending: Pending[];
  let quests: PatrolQuestStart[];
  let questAnswer: { ok: true } | { ok: false; reason: string };
  let onQuest: ((start: PatrolQuestStart) => void) | undefined;
  let logs: string[];
  let forgotten: string[];
  let fromApp: boolean;
  let patrols: Patrols | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'patrols-'));
    dir = join(home, 'patrols');
    mkdirSync(dir);
    mkdirSync(join(home, 'code', 'app'), { recursive: true });
    now = NOON;
    lists = [];
    sent = [];
    pending = [];
    quests = [];
    questAnswer = { ok: true };
    onQuest = undefined;
    logs = [];
    forgotten = [];
    fromApp = true;
  });

  afterEach(async () => {
    await patrols?.close();
    patrols = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  const hourly = { cron: '0 * * * *', timezone: 'UTC' };

  function script(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { name: 'Backup check', schedule: hourly, script: { command: ['./check.sh'] }, ...overrides };
  }

  function quest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      name: 'Sweep',
      schedule: hourly,
      quest: { project: '~/code/app', prompt: 'sweep.md', mode: 'auto' },
      ...overrides,
    };
  }

  function patrolFolder(id: string, json: unknown = script(), files: Record<string, string> = {}): void {
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(join(dir, id, 'patrol.json'), typeof json === 'string' ? json : JSON.stringify(json));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, id, name), text);
  }

  function make(): Patrols {
    patrols = createPatrols({
      dir,
      home,
      statePath: join(home, 'patrols-state.json'),
      env: { PATH: '/bin', CRYSTAL_TOKEN: 'secret' },
      fromApp: () => fromApp,
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
            finish({ kind: 'exited', code: null, signal: 'SIGTERM', stdout: '', stderr: '' });
          },
        };
      },
      startQuest: async (start) => {
        quests.push(start);
        onQuest?.(start);
        return questAnswer;
      },
      onPatrols: (list) => lists.push(list),
      onRun: (patrol, run) => sent.push({ patrol, run }),
      log: (line) => logs.push(line),
      forgetQuest: (session) => forgotten.push(session),
    });
    return patrols;
  }

  /** Finishes the oldest script still running, and waits for its run to be sent. */
  async function finish(result: CollectResult): Promise<void> {
    const entry = pending.shift();
    if (!entry) throw new Error('no script is running');
    entry.finish(result);
    await patrols!.idle();
  }

  const listed = (id = 'backup') => patrols!.list().find((patrol) => patrol.id === id);
  /** The first hour after `from`, with the Patrol's jitter. */
  const slot = (from: number, id = 'backup') => Math.floor(from / HOUR + 1) * HOUR + jitterOf(id);
  const ended = (id = 'backup') => sent.filter((one) => one.patrol === id && one.run.outcome !== 'running');

  describe('finding Patrols', () => {
    it('lists each folder with a patrol.json, with when it sets out next, and doesn’t run a new one at once', async () => {
      patrolFolder('backup');
      patrolFolder('sweep', quest(), { 'sweep.md': 'Sweep the deps.' });
      make();
      await patrols!.tick();
      expect(patrols!.list().map((patrol) => patrol.id)).toEqual(['backup', 'sweep']);
      expect(listed()).toMatchObject({ manifest: { name: 'Backup check' }, nextRunAt: slot(NOON) });
      expect(pending).toHaveLength(0);
      expect(lists).toHaveLength(1);
    });

    it('keeps the last good patrol.json and shows why the new one doesn’t load', async () => {
      patrolFolder('backup');
      make();
      await patrols!.tick();
      patrolFolder('backup', '{ not json');
      await patrols!.tick();
      expect(listed()?.manifest?.name).toBe('Backup check');
      expect(listed()?.error).toMatch(/patrol.json isn't JSON/);
      patrolFolder('broken', {
        ...script(),
        schedule: { rule: 'FREQ=SECONDLY', start: '2026-11-17T09:00', timezone: 'UTC' },
      });
      await patrols!.tick();
      expect(listed('broken')).toMatchObject({ error: expect.stringMatching(/SECONDLY/) });
      expect(listed('broken')?.manifest).toBeUndefined();
    });
  });

  describe('script Patrols', () => {
    it('runs its command in its folder without the node token, and keeps the end of what it wrote', async () => {
      patrolFolder('backup', script({ script: { command: ['./check.sh', '--quick'], timeoutSeconds: 60 } }));
      make();
      await patrols!.tick();
      now = slot(NOON);
      await patrols!.tick();
      expect(pending).toHaveLength(1);
      const request = pending[0]!.request;
      expect(request.cwd).toBe(join(dir, 'backup'));
      expect(request.command).toEqual(['./check.sh', '--quick']);
      expect(request.timeoutMs).toBe(60_000);
      expect(request.env.CRYSTAL_TOKEN).toBeUndefined();
      expect(request.env.CRYSTAL_PATROL).toBe('backup');
      expect(sent[0]?.run).toMatchObject({ outcome: 'running', trigger: 'schedule', scheduledAt: slot(NOON) });
      await finish(exited(0, `${'x'.repeat(9000)}done`, 'a warning'));
      const run = ended()[0]!.run;
      expect(run).toMatchObject({ id: sent[0]!.run.id, outcome: 'finished', exitCode: 0, stderr: 'a warning' });
      expect(run.stdout?.endsWith('done')).toBe(true);
      expect(run.stdout?.length).toBe(8000);
      expect(run.finishedAt).toBeDefined();
    });

    it('fails on any other exit code, and times out after its limit', async () => {
      patrolFolder('backup');
      make();
      await patrols!.tick();
      patrols!.runNow('backup');
      expect(pending[0]?.request.timeoutMs).toBe(DEFAULT_SCRIPT_TIMEOUT_SECONDS * 1000);
      await finish(exited(2, '', 'disk full'));
      expect(ended()[0]?.run).toMatchObject({ outcome: 'failed', exitCode: 2, trigger: 'now' });
      patrols!.runNow('backup');
      await finish({ kind: 'timed-out', stderr: '' });
      expect(ended()[1]?.run).toMatchObject({ outcome: 'timed-out' });
      expect(listed()?.failures).toBe(2);
    });

    it('records a run due while the last is still out as skipped', async () => {
      patrolFolder('backup');
      make();
      await patrols!.tick();
      patrols!.runNow('backup');
      now = slot(NOON);
      await patrols!.tick();
      expect(pending).toHaveLength(1);
      expect(ended()[0]?.run).toMatchObject({ outcome: 'skipped', trigger: 'schedule', scheduledAt: slot(NOON) });
    });
  });

  describe('missed runs', () => {
    it('catches up once within its window, after a sleep across several runs', async () => {
      patrolFolder('backup', script({ catchUp: '6h' }));
      make();
      await patrols!.tick();
      now = NOON + 5 * HOUR + 30 * MINUTE;
      await patrols!.tick();
      expect(pending).toHaveLength(1);
      // The latest time it was due, not the first it missed.
      expect(sent[0]?.run).toMatchObject({ trigger: 'catch-up', scheduledAt: NOON + 5 * HOUR + jitterOf('backup') });
      await finish(exited(0));
      expect(listed()?.nextRunAt).toBe(slot(now));
    });

    it('records a run older than its window as missed, and doesn’t run it', async () => {
      patrolFolder('backup', script({ catchUp: '2h', schedule: { cron: '0 3 * * *', timezone: 'UTC' } }));
      make();
      await patrols!.tick();
      now = Date.parse('2026-11-18T08:00:00Z');
      await patrols!.tick();
      expect(pending).toHaveLength(0);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.run).toMatchObject({
        outcome: 'missed',
        scheduledAt: Date.parse('2026-11-18T03:00:00Z') + jitterOf('backup'),
      });
      expect(sent[0]?.run.reason).toMatch(/2h/);
      expect(listed()?.nextRunAt).toBe(Date.parse('2026-11-19T03:00:00Z') + jitterOf('backup'));
    });

    it('takes 6h as the window when unset, and catches nothing up with `never`', async () => {
      patrolFolder('backup', script({ schedule: { cron: '0 3 * * *', timezone: 'UTC' } }));
      patrolFolder('strict', script({ catchUp: 'never', schedule: { cron: '0 3 * * *', timezone: 'UTC' } }));
      make();
      await patrols!.tick();
      now = Date.parse('2026-11-18T08:59:00Z');
      await patrols!.tick();
      expect(pending).toHaveLength(1);
      expect(sent.find((one) => one.patrol === 'backup')?.run.trigger).toBe('catch-up');
      expect(sent.find((one) => one.patrol === 'strict')?.run.outcome).toBe('missed');
    });

    it('finds the latest missed time of a frequent rule quickly after a long sleep', async () => {
      patrolFolder(
        'backup',
        script({ schedule: { rule: 'FREQ=MINUTELY', start: '2026-11-01T00:00', timezone: 'UTC' } }),
      );
      make();
      await patrols!.tick();
      now = NOON + 30 * 24 * HOUR + 30_000;
      const began = performance.now();
      await patrols!.tick();
      expect(performance.now() - began).toBeLessThan(500);
      // Every minute, so the latest time was within the last minute: on time, after a month asleep.
      const latest = Math.floor((now - jitterOf('backup')) / MINUTE) * MINUTE + jitterOf('backup');
      expect(sent[0]?.run).toMatchObject({ trigger: 'schedule', scheduledAt: latest });
    });

    it('counts a tick that is only a little late as on time', async () => {
      patrolFolder('backup', script({ catchUp: 'never' }));
      make();
      await patrols!.tick();
      now = slot(NOON) + 90_000;
      await patrols!.tick();
      expect(sent[0]?.run).toMatchObject({ outcome: 'running', trigger: 'schedule' });
    });
  });

  describe('standing down', () => {
    it('stands down after three failures in a row, until a run by hand works', async () => {
      patrolFolder('backup');
      make();
      await patrols!.tick();
      for (let i = 0; i < FAILURES_TO_STAND_DOWN; i++) {
        now = listed()!.nextRunAt!;
        await patrols!.tick();
        await finish(exited(1));
      }
      expect(listed()?.paused).toMatch(/3 failed runs in a row/);
      expect(listed()?.nextRunAt).toBeUndefined();
      now += 2 * HOUR;
      await patrols!.tick();
      expect(pending).toHaveLength(0);
      patrols!.runNow('backup');
      await finish(exited(0));
      expect(listed()?.paused).toBeUndefined();
      expect(listed()?.failures).toBeUndefined();
      expect(listed()?.nextRunAt).toBe(slot(now));
    });

    it('counts neither skips nor missed runs as failures', async () => {
      patrolFolder('backup');
      make();
      await patrols!.tick();
      patrols!.runNow('backup');
      patrols!.runNow('backup');
      expect(ended()[0]?.run.outcome).toBe('skipped');
      await finish(exited(0));
      expect(listed()?.failures).toBeUndefined();
    });

    it('stays paused by hand through a Run now that works, until resumed', async () => {
      patrolFolder('backup');
      make();
      await patrols!.tick();
      expect(await patrols!.change('backup', { op: 'pause' })).toEqual({ ok: true });
      expect(listed()?.paused).toMatch(/by hand/);
      patrols!.runNow('backup');
      await finish(exited(0));
      expect(listed()?.paused).toMatch(/by hand/);
      now = NOON + 5 * HOUR + 30 * MINUTE;
      expect(await patrols!.change('backup', { op: 'resume' })).toEqual({ ok: true });
      // What it missed while paused isn't caught up.
      await patrols!.tick();
      expect(pending).toHaveLength(0);
      expect(listed()).toMatchObject({ nextRunAt: slot(now) });
      expect(listed()?.paused).toBeUndefined();
    });

    it('fires a one-off once, then has no next time', async () => {
      patrolFolder('backup', script({ schedule: { once: '2026-11-17T13:00', timezone: 'UTC' } }));
      make();
      await patrols!.tick();
      now = Date.parse('2026-11-17T13:01:00Z');
      await patrols!.tick();
      await finish(exited(0));
      expect(listed()?.nextRunAt).toBeUndefined();
      now += 2 * HOUR;
      await patrols!.tick();
      expect(pending).toHaveLength(0);
    });

    it('keeps its pause when its folder is away for a moment', async () => {
      patrolFolder('backup');
      make();
      await patrols!.tick();
      await patrols!.change('backup', { op: 'pause' });
      renameSync(join(dir, 'backup'), join(home, 'away'));
      await patrols!.tick();
      expect(listed()).toBeUndefined();
      renameSync(join(home, 'away'), join(dir, 'backup'));
      await patrols!.tick();
      expect(listed()?.paused).toMatch(/by hand/);
    });

    it('waits for its first time when its folder comes back after a while, keeping its failures', async () => {
      patrolFolder('backup');
      make();
      await patrols!.tick();
      patrols!.runNow('backup');
      await finish(exited(1));
      sent = [];
      renameSync(join(dir, 'backup'), join(home, 'away'));
      await patrols!.tick();
      now += 5 * HOUR;
      renameSync(join(home, 'away'), join(dir, 'backup'));
      await patrols!.tick();
      expect(pending).toHaveLength(0);
      expect(sent).toHaveLength(0);
      expect(listed()).toMatchObject({ failures: 1, nextRunAt: slot(now) });
    });

    it('says so when its state file can’t be read', async () => {
      writeFileSync(join(home, 'patrols-state.json'), '{ trunc');
      patrolFolder('backup');
      make();
      await patrols!.tick();
      expect(logs.some((line) => /state/.test(line))).toBe(true);
    });

    it('keeps its next time and pause across a restart', async () => {
      patrolFolder('backup');
      make();
      await patrols!.tick();
      await patrols!.change('backup', { op: 'pause' });
      await patrols!.close();
      make();
      await patrols!.tick();
      expect(listed()?.paused).toMatch(/by hand/);
      await patrols!.change('backup', { op: 'resume' });
      expect(listed()?.nextRunAt).toBe(slot(NOON));
    });
  });

  describe('Quest Patrols', () => {
    it('starts a Quest from its prompt file, in its project, as New Quest would', async () => {
      patrolFolder(
        'sweep',
        quest({ quest: { project: '~/code/app', prompt: 'sweep.md', mode: 'auto', effort: 'high', worktree: true } }),
        { 'sweep.md': 'Sweep the deps.\n' },
      );
      make();
      await patrols!.tick();
      patrols!.runNow('sweep');
      await patrols!.idle();
      expect(quests).toHaveLength(1);
      expect(quests[0]).toMatchObject({
        cwd: join(home, 'code', 'app'),
        prompt: 'Sweep the deps.\n',
        mode: 'auto',
        effort: 'high',
        worktree: true,
        waitForYouMs: 30 * MINUTE,
      });
      expect(quests[0]!.link).toEqual({ patrol: 'sweep', run: sent[0]!.run.id });
      expect(sent[0]?.run).toMatchObject({ outcome: 'running', session: quests[0]!.session });
    });

    it('takes the prompt itself, and the Kingdom’s defaults for what it leaves out', async () => {
      patrolFolder('sweep', quest({ quest: { project: '~/code/app', promptText: 'Look around.', waitForYou: '2h' } }));
      make();
      await patrols!.tick();
      patrols!.runNow('sweep');
      await patrols!.idle();
      expect(quests[0]).toEqual({
        cwd: join(home, 'code', 'app'),
        prompt: 'Look around.',
        waitForYouMs: 2 * HOUR,
        session: sent[0]!.run.session,
        link: { patrol: 'sweep', run: sent[0]!.run.id },
      });
    });

    it('stays out until its Quest’s turn ends, and takes the outcome the Quest ended with', async () => {
      patrolFolder('sweep', quest(), { 'sweep.md': 'Sweep.' });
      make();
      await patrols!.tick();
      patrols!.runNow('sweep');
      await patrols!.idle();
      patrols!.runNow('sweep');
      await patrols!.idle();
      expect(quests).toHaveLength(1);
      expect(ended('sweep')[0]?.run.outcome).toBe('skipped');
      const session = quests[0]!.session;
      patrols!.questEnded(session, { outcome: 'needs-you', reason: 'nobody answered within 30m' });
      expect(ended('sweep')[1]?.run).toMatchObject({
        id: sent[0]!.run.id,
        outcome: 'needs-you',
        session,
        reason: 'nobody answered within 30m',
      });
      expect(listed('sweep')?.failures).toBeUndefined();
      // Another end for the same Quest, as its later turns would give, changes nothing.
      patrols!.questEnded(session, { outcome: 'failed' });
      expect(ended('sweep')).toHaveLength(2);
    });

    it('fails a run whose Quest doesn’t start, or whose project or prompt file is missing', async () => {
      patrolFolder('sweep', quest(), { 'sweep.md': 'Sweep.' });
      patrolFolder('lost', quest({ quest: { project: '~/code/gone', promptText: 'x' } }));
      patrolFolder('blank', quest({ quest: { project: '~/code/app', prompt: 'missing.md' } }));
      questAnswer = { ok: false, reason: 'this node cannot create worktrees' };
      make();
      await patrols!.tick();
      for (const id of ['sweep', 'lost', 'blank']) patrols!.runNow(id);
      await patrols!.idle();
      expect(ended('sweep')[0]?.run).toMatchObject({ outcome: 'failed', reason: 'this node cannot create worktrees' });
      expect(ended('lost')[0]?.run.reason).toMatch(/no such project folder/);
      expect(ended('blank')[0]?.run.reason).toMatch(/missing.md/);
      expect(quests).toHaveLength(1);
    });

    it('takes the end of a Quest that ends while it is still starting', async () => {
      patrolFolder('sweep', quest(), { 'sweep.md': 'Sweep.' });
      onQuest = (start) => patrols!.questEnded(start.session, { outcome: 'failed', reason: 'claude could not start' });
      make();
      await patrols!.tick();
      patrols!.runNow('sweep');
      await patrols!.idle();
      expect(ended('sweep')[0]?.run).toMatchObject({ outcome: 'failed', reason: 'claude could not start' });
      onQuest = undefined;
      patrols!.runNow('sweep');
      await patrols!.idle();
      expect(quests).toHaveLength(2);
      expect(ended('sweep')).toHaveLength(1);
    });

    it('ends a run left out by a stop once its Patrol loads again, even if it didn’t at first', async () => {
      patrolFolder('sweep', quest(), { 'sweep.md': 'Sweep.' });
      make();
      await patrols!.tick();
      patrols!.runNow('sweep');
      await patrols!.idle();
      await patrols!.close();
      writeFileSync(join(dir, 'sweep', 'patrol.json'), '{ broken');
      sent = [];
      make();
      await patrols!.tick();
      expect(sent).toHaveLength(0);
      patrolFolder('sweep', quest(), { 'sweep.md': 'Sweep.' });
      await patrols!.tick();
      expect(sent[0]?.run).toMatchObject({ outcome: 'failed', reason: expect.stringMatching(/Crystal stopped/) });
    });

    it('ends a left-out run before a run that starts between ticks can take its place', async () => {
      patrolFolder('sweep', quest(), { 'sweep.md': 'Sweep.' });
      make();
      await patrols!.tick();
      patrols!.runNow('sweep');
      await patrols!.idle();
      const left = sent[0]!.run.id;
      await patrols!.close();
      writeFileSync(join(dir, 'sweep', 'patrol.json'), '{ broken');
      sent = [];
      make();
      await patrols!.tick();
      patrolFolder('sweep', quest(), { 'sweep.md': 'Sweep.' });
      await patrols!.change('sweep', { op: 'resume' });
      patrols!.runNow('sweep');
      await patrols!.idle();
      expect(sent.find((one) => one.run.id === left)?.run.outcome).toBe('failed');
    });

    it('leaves no session on a run whose Quest didn’t start', async () => {
      patrolFolder('sweep', quest(), { 'sweep.md': 'Sweep.' });
      questAnswer = { ok: false, reason: 'nope' };
      make();
      await patrols!.tick();
      patrols!.runNow('sweep');
      await patrols!.idle();
      expect(ended('sweep')[0]?.run.session).toBeUndefined();
    });

    it('stops treating a deleted Patrol’s Quest as the Patrol’s', async () => {
      patrolFolder('sweep', quest(), { 'sweep.md': 'Sweep.' });
      make();
      await patrols!.tick();
      patrols!.runNow('sweep');
      await patrols!.idle();
      await patrols!.change('sweep', { op: 'delete' });
      expect(forgotten).toEqual([quests[0]!.session]);
    });

    it('leaves a run out when its Quest ends because Crystal is stopping', async () => {
      patrolFolder('sweep', quest(), { 'sweep.md': 'Sweep.' });
      make();
      await patrols!.tick();
      patrols!.runNow('sweep');
      await patrols!.idle();
      const closing = patrols!.close();
      patrols!.questEnded(quests[0]!.session, { outcome: 'failed' });
      await closing;
      expect(ended('sweep')).toHaveLength(0);
      make();
      await patrols!.tick();
      expect(ended('sweep')[0]?.run.reason).toMatch(/Crystal stopped/);
      expect(listed('sweep')?.failures).toBeUndefined();
    });

    it('ends a run that was out when Crystal stopped, once it’s back', async () => {
      patrolFolder('sweep', quest(), { 'sweep.md': 'Sweep.' });
      make();
      await patrols!.tick();
      patrols!.runNow('sweep');
      await patrols!.idle();
      await patrols!.close();
      now += HOUR;
      sent = [];
      make();
      await patrols!.tick();
      expect(sent[0]?.run).toMatchObject({ outcome: 'failed', reason: expect.stringMatching(/Crystal stopped/) });
      expect(patrols!.recent().map((frame) => frame.run.outcome)).toEqual(['failed']);
      expect(listed('sweep')?.failures).toBeUndefined();
    });
  });

  describe('changes from the app', () => {
    const manifest = {
      name: 'Sweep',
      schedule: { rule: 'FREQ=WEEKLY;BYDAY=TU', start: '2026-12-01T09:00', timezone: 'UTC' },
      quest: { project: '~/code/app', prompt: 'sweep.md' },
    };

    it('saves a Quest Patrol as a folder of files, and lists it', async () => {
      make();
      await patrols!.tick();
      const answer = await patrols!.change('sweep', { op: 'save', manifest, prompt: 'Sweep the deps.' });
      expect(answer).toEqual({ ok: true });
      expect(JSON.parse(readFileSync(join(dir, 'sweep', 'patrol.json'), 'utf8'))).toEqual(manifest);
      expect(readFileSync(join(dir, 'sweep', 'sweep.md'), 'utf8')).toBe('Sweep the deps.');
      expect(listed('sweep')).toMatchObject({
        manifest,
        nextRunAt: Date.parse('2026-12-01T09:00Z') + jitterOf('sweep'),
      });
    });

    it('refuses what a file couldn’t say, a script, a Kingdom that takes no Patrols from the app, and a missing folder', async () => {
      patrolFolder('backup');
      make();
      await patrols!.tick();
      const save = (id: string, body: unknown, prompt?: string) =>
        patrols!.change(id, { op: 'save', manifest: body, ...(prompt ? { prompt } : {}) } as never);
      expect(await save('backup', manifest, 'x')).toMatchObject({ ok: false, reason: expect.stringMatching(/script/) });
      expect(await save('new', script())).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/Quest Patrols only/),
      });
      expect(
        await save(
          'new',
          { ...manifest, schedule: { rule: 'FREQ=SECONDLY', start: '2026-12-01T09:00', timezone: 'UTC' } },
          'x',
        ),
      ).toMatchObject({ ok: false, reason: expect.stringMatching(/SECONDLY/) });
      expect(await save('new', { ...manifest, quest: { project: '~/code/gone', promptText: 'x' } })).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/no such project folder/),
      });
      expect(await save('new', manifest)).toMatchObject({ ok: false, reason: expect.stringMatching(/sweep.md/) });
      fromApp = false;
      expect(await save('new', manifest, 'x')).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/from files \(CRYSTAL_PATROLS_FROM_APP is off\)/),
      });
      expect(existsSync(join(dir, 'new'))).toBe(false);
    });

    it('never saves over a script Patrol whose patrol.json doesn’t load, even one it has never loaded', async () => {
      patrolFolder('backup');
      make();
      await patrols!.tick();
      writeFileSync(
        join(dir, 'backup', 'patrol.json'),
        JSON.stringify(script({ script: { command: ['./check.sh'], timeoutSeconds: -5 } })),
      );
      const save = () => patrols!.change('backup', { op: 'save', manifest: manifest as never, prompt: 'replaced' });
      expect(await save()).toMatchObject({ ok: false, reason: expect.stringMatching(/script/) });
      await patrols!.close();
      make();
      await patrols!.tick();
      expect(listed()?.manifest).toBeUndefined();
      expect(await save()).toMatchObject({ ok: false, reason: expect.stringMatching(/doesn’t load/) });
      writeFileSync(join(dir, 'backup', 'patrol.json'), '{ broken');
      expect(await save()).toMatchObject({ ok: false, reason: expect.stringMatching(/doesn’t load/) });
      expect(existsSync(join(dir, 'backup', 'sweep.md'))).toBe(false);
    });

    it('deletes a Patrol by moving its folder aside, stopping a run that is out', async () => {
      patrolFolder('backup');
      make();
      await patrols!.tick();
      patrols!.runNow('backup');
      expect(await patrols!.change('backup', { op: 'delete' })).toEqual({ ok: true });
      expect(pending[0]?.stopped).toBe(true);
      await patrols!.idle();
      expect(patrols!.list()).toEqual([]);
      // Its run is ended before the list drops it, so the hub doesn't keep it out for good.
      expect(ended()[0]?.run).toMatchObject({ outcome: 'failed', reason: expect.stringMatching(/deleted/) });
      expect(lists.at(-1)).toEqual([]);
      expect(existsSync(join(dir, 'backup'))).toBe(false);
      const aside = readdirSync(join(dir, '.deleted'));
      expect(aside).toHaveLength(1);
      expect(aside[0]).toMatch(/^backup-/);
      expect(existsSync(join(dir, '.deleted', aside[0]!, 'patrol.json'))).toBe(true);
      expect(await patrols!.change('backup', { op: 'pause' })).toMatchObject({ ok: false });
    });

    it('leaves a run alone when its folder can’t be moved aside', async () => {
      patrolFolder('backup');
      writeFileSync(join(dir, '.deleted'), 'in the way');
      make();
      await patrols!.tick();
      patrols!.runNow('backup');
      expect(await patrols!.change('backup', { op: 'delete' })).toMatchObject({ ok: false });
      expect(pending[0]?.stopped).toBe(false);
      expect(listed()).toBeDefined();
    });

    it('records why Run now can’t run a Patrol whose patrol.json doesn’t load', async () => {
      patrolFolder('backup', '{ not json');
      make();
      await patrols!.tick();
      patrols!.runNow('backup');
      expect(sent[0]?.run).toMatchObject({
        trigger: 'now',
        outcome: 'failed',
        reason: expect.stringMatching(/isn't JSON/),
      });
    });

    it('never writes over a file it didn’t put there, and keeps within the Patrols it reads', async () => {
      mkdirSync(join(dir, 'job'));
      writeFileSync(join(dir, 'job', 'run.sh'), 'echo mine');
      make();
      await patrols!.tick();
      const body = { ...manifest, quest: { project: '~/code/app', prompt: 'run.sh' } };
      expect(await patrols!.change('job', { op: 'save', manifest: body as never, prompt: 'Sweep.' })).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/already a run.sh/),
      });
      expect(readFileSync(join(dir, 'job', 'run.sh'), 'utf8')).toBe('echo mine');
      // Editing a Quest Patrol's own prompt is fine.
      expect(await patrols!.change('sweep', { op: 'save', manifest, prompt: 'One.' })).toEqual({ ok: true });
      expect(await patrols!.change('sweep', { op: 'save', manifest, prompt: 'Two.' })).toEqual({ ok: true });
      expect(readFileSync(join(dir, 'sweep', 'sweep.md'), 'utf8')).toBe('Two.');
      for (let i = 0; i < 98; i++) mkdirSync(join(dir, `p${String(i).padStart(3, '0')}`));
      expect(await patrols!.change('a-new', { op: 'save', manifest, prompt: 'x' })).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/100 Patrols/),
      });
    });

    it('pauses, resumes and deletes even where the app may not save', async () => {
      patrolFolder('backup');
      fromApp = false;
      make();
      await patrols!.tick();
      expect(await patrols!.change('backup', { op: 'pause' })).toEqual({ ok: true });
      expect(await patrols!.change('backup', { op: 'resume' })).toEqual({ ok: true });
      expect(await patrols!.change('backup', { op: 'delete' })).toEqual({ ok: true });
    });
  });

  it('sends each Patrol’s latest runs again after a reconnect', async () => {
    patrolFolder('backup');
    make();
    await patrols!.tick();
    for (let i = 0; i < 7; i++) {
      patrols!.runNow('backup');
      await finish(exited(0));
    }
    const recent = patrols!.recent();
    expect(recent.every((frame) => frame.kind === 'patrol-run' && frame.patrol === 'backup')).toBe(true);
    expect(recent.at(-1)?.run.outcome).toBe('finished');
    expect(new Set(recent.map((frame) => frame.run.id)).size).toBe(recent.length);
    expect(recent).toHaveLength(5);
  });
});
