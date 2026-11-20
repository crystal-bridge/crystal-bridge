import { describe, expect, it } from 'vitest';
import { HubToClient, NodeHello } from './commands.js';
import {
  HubPatrolChange,
  HubPatrolPreview,
  MAX_PATROL_PREVIEW,
  MAX_PATROL_OUTPUT,
  NodePatrolChanged,
  NodePatrolPreviewed,
  NodePatrolRun,
  NodePatrols,
  PatrolChangeRequest,
  PatrolLink,
  PatrolManifest,
  PatrolPreviewRequest,
  PatrolRun,
  PatrolSchedule,
} from './patrols.js';

const RUN = '33333333-3333-4333-8333-333333333333';
const REQUEST = '44444444-4444-4444-8444-444444444444';

const questPatrol = {
  name: 'Weekly dependency sweep',
  schedule: { rule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU', start: '2026-12-01T09:00', timezone: 'America/Chicago' },
  quest: { project: '~/code/my-app', prompt: 'sweep.md', mode: 'auto', worktree: true },
};
const scriptPatrol = {
  name: 'Nightly backup check',
  schedule: { cron: '30 3 * * *', timezone: 'Europe/Berlin' },
  script: { command: ['./check.sh'], timeoutSeconds: 600 },
};

describe('PatrolSchedule', () => {
  it('takes a recurrence rule, five-field cron or a single time, each with a time zone', () => {
    expect(PatrolSchedule.safeParse(questPatrol.schedule).success).toBe(true);
    expect(PatrolSchedule.safeParse(scriptPatrol.schedule).success).toBe(true);
    expect(PatrolSchedule.safeParse({ once: '2026-11-21T15:00', timezone: 'UTC' }).success).toBe(true);
    expect(
      PatrolSchedule.safeParse({ ...questPatrol.schedule, except: ['2026-12-29'], rule: 'RRULE:FREQ=DAILY;COUNT=10' })
        .success,
    ).toBe(true);
  });

  it('refuses a schedule without a time zone, a rule without FREQ, cron with the wrong field count, or two forms', () => {
    expect(PatrolSchedule.safeParse({ cron: '30 3 * * *' }).success).toBe(false);
    expect(PatrolSchedule.safeParse({ rule: 'BYDAY=TU', start: '2026-12-01T09:00', timezone: 'UTC' }).success).toBe(
      false,
    );
    expect(PatrolSchedule.safeParse({ cron: '30 3 * *', timezone: 'UTC' }).success).toBe(false);
    expect(PatrolSchedule.safeParse({ rule: 'FREQ=DAILY', timezone: 'UTC' }).success).toBe(false);
    expect(PatrolSchedule.safeParse({ cron: '30 3 * * *', once: '2026-11-21T15:00', timezone: 'UTC' }).success).toBe(
      false,
    );
  });
});

describe('PatrolManifest', () => {
  it('reads the Quest and script examples from the docs', () => {
    expect(PatrolManifest.parse(questPatrol)).toMatchObject({ quest: { prompt: 'sweep.md' } });
    expect(PatrolManifest.parse(scriptPatrol)).toMatchObject({ script: { command: ['./check.sh'] } });
  });

  it('takes a Board, a catch-up window and a wait for you', () => {
    const parsed = PatrolManifest.parse({
      ...questPatrol,
      board: 'quest-board',
      catchUp: 'never',
      quest: { ...questPatrol.quest, waitForYou: '30m' },
    });
    expect(parsed).toMatchObject({ board: 'quest-board', catchUp: 'never', quest: { waitForYou: '30m' } });
    expect(PatrolManifest.safeParse({ ...scriptPatrol, catchUp: '6h' }).success).toBe(true);
    expect(PatrolManifest.safeParse({ ...scriptPatrol, catchUp: 'soon' }).success).toBe(false);
  });

  it('needs exactly one of a Quest and a script', () => {
    expect(PatrolManifest.safeParse({ ...questPatrol, script: scriptPatrol.script }).success).toBe(false);
    expect(PatrolManifest.safeParse({ name: 'x', schedule: scriptPatrol.schedule }).success).toBe(false);
  });

  it('needs a Quest to have exactly one of a prompt file and prompt text', () => {
    const quest = { project: '~/code/my-app' };
    expect(PatrolManifest.safeParse({ ...questPatrol, quest }).success).toBe(false);
    expect(
      PatrolManifest.safeParse({ ...questPatrol, quest: { ...quest, prompt: 'a.md', promptText: 'Do it' } }).success,
    ).toBe(false);
    expect(PatrolManifest.safeParse({ ...questPatrol, quest: { ...quest, promptText: 'Do it' } }).success).toBe(true);
  });

  it('keeps a prompt file inside the Patrol folder', () => {
    const quest = { project: '~/code/my-app', prompt: '../elsewhere.md' };
    expect(PatrolManifest.safeParse({ ...questPatrol, quest }).success).toBe(false);
  });

  it('won’t name patrol.json or a dot-file as the prompt, so prompt text can’t replace the manifest', () => {
    for (const prompt of ['patrol.json', 'Patrol.JSON', '.env'])
      expect(PatrolManifest.safeParse({ ...questPatrol, quest: { project: '~/code/my-app', prompt } }).success).toBe(
        false,
      );
  });
});

describe('NodePatrols', () => {
  it('keeps a Patrol this hub can’t read as an error, and the rest as they are', () => {
    const frame = NodePatrols.parse({
      kind: 'patrols',
      patrols: [
        { id: 'sweep', manifest: questPatrol, nextRunAt: 5, failures: 0 },
        { id: 'future', manifest: { ...scriptPatrol, schedule: { lunar: 'full', timezone: 'UTC' } } },
        { manifest: scriptPatrol },
      ],
    });
    expect(frame.patrols).toHaveLength(2);
    expect(frame.patrols[0]).toMatchObject({ id: 'sweep', nextRunAt: 5 });
    expect(frame.patrols[1]).toMatchObject({ id: 'future', error: expect.stringMatching(/newer hub/) });
  });

  it('refuses two Patrols with one id', () => {
    const patrol = { id: 'sweep', manifest: questPatrol };
    expect(NodePatrols.safeParse({ kind: 'patrols', patrols: [patrol, patrol] }).success).toBe(false);
  });
});

describe('PatrolRun', () => {
  const run = { id: RUN, scheduledAt: 1, startedAt: 2, trigger: 'schedule', outcome: 'running' };

  it('takes a run still out, and one that came back with its Quest or its script’s output', () => {
    expect(PatrolRun.safeParse(run).success).toBe(true);
    expect(PatrolRun.safeParse({ ...run, finishedAt: 3, outcome: 'finished', session: RUN }).success).toBe(true);
    expect(
      PatrolRun.safeParse({ ...run, finishedAt: 3, outcome: 'failed', exitCode: 2, stdout: 'x', stderr: 'y' }).success,
    ).toBe(true);
  });

  it('takes outcomes and triggers from a newer Kingdom, but only as short words', () => {
    expect(PatrolRun.safeParse({ ...run, outcome: 'lost-in-the-woods' }).success).toBe(true);
    expect(PatrolRun.safeParse({ ...run, outcome: 'Not A Word' }).success).toBe(false);
  });

  it('caps a script’s output', () => {
    expect(PatrolRun.safeParse({ ...run, stdout: 'x'.repeat(MAX_PATROL_OUTPUT + 1) }).success).toBe(false);
  });

  it('is reported in a frame naming its Patrol', () => {
    expect(NodePatrolRun.safeParse({ kind: 'patrol-run', patrol: 'sweep', run }).success).toBe(true);
    expect(NodePatrolRun.safeParse({ kind: 'patrol-run', patrol: 'Sweep!', run }).success).toBe(false);
  });
});

describe('changing a Patrol from the app', () => {
  it('saves a Quest manifest with an optional prompt file, deletes, pauses and resumes', () => {
    expect(PatrolChangeRequest.safeParse({ op: 'save', manifest: questPatrol }).success).toBe(true);
    expect(
      PatrolChangeRequest.safeParse({ op: 'save', manifest: questPatrol, prompt: 'Update the dependencies.' }).success,
    ).toBe(true);
    for (const op of ['delete', 'pause', 'resume']) expect(PatrolChangeRequest.safeParse({ op }).success).toBe(true);
  });

  it('refuses prompt text for a manifest that names no prompt file', () => {
    const inline = { ...questPatrol, quest: { project: '~/code/app', promptText: 'Sweep.' } };
    expect(PatrolChangeRequest.safeParse({ op: 'save', manifest: inline }).success).toBe(true);
    expect(PatrolChangeRequest.safeParse({ op: 'save', manifest: inline, prompt: 'Hi' }).success).toBe(false);
  });

  it('refuses a script Patrol: one runs with no approval, so it comes only from a file on the Kingdom', () => {
    expect(PatrolChangeRequest.safeParse({ op: 'save', manifest: scriptPatrol }).success).toBe(false);
  });

  it('goes to the Kingdom with a request id, and comes back answered', () => {
    expect(
      HubPatrolChange.safeParse({ kind: 'patrol-change', requestId: REQUEST, patrol: 'sweep', change: { op: 'pause' } })
        .success,
    ).toBe(true);
    expect(
      NodePatrolChanged.safeParse({ kind: 'patrol-changed', requestId: REQUEST, ok: false, reason: 'read-only' })
        .success,
    ).toBe(true);
  });
});

describe('Patrol previews', () => {
  const schedule = { cron: '0 9 * * 1', timezone: 'Europe/Berlin' };

  it('asks for a schedule as patrol.json takes it, and a few times', () => {
    expect(PatrolPreviewRequest.parse({ schedule })).toEqual({ schedule, count: 5 });
    expect(PatrolPreviewRequest.parse({ schedule, count: MAX_PATROL_PREVIEW }).count).toBe(MAX_PATROL_PREVIEW);
    expect(PatrolPreviewRequest.safeParse({ schedule, count: MAX_PATROL_PREVIEW + 1 }).success).toBe(false);
    expect(PatrolPreviewRequest.safeParse({ schedule, count: 0 }).success).toBe(false);
  });

  it('refuses a schedule patrol.json would refuse, in words', () => {
    const bad = PatrolPreviewRequest.safeParse({ schedule: { cron: '0 9 * * 1' } });
    expect(bad.success).toBe(false);
  });

  it('goes to the Kingdom with a request id, and comes back with times or a reason', () => {
    expect(HubPatrolPreview.safeParse({ kind: 'patrol-preview', requestId: REQUEST, schedule, count: 3 }).success).toBe(
      true,
    );
    expect(
      NodePatrolPreviewed.safeParse({ kind: 'patrol-previewed', requestId: REQUEST, times: [1, 2, 3] }).success,
    ).toBe(true);
    expect(
      NodePatrolPreviewed.safeParse({ kind: 'patrol-previewed', requestId: REQUEST, reason: 'no such zone' }).success,
    ).toBe(true);
    const many = Array.from({ length: MAX_PATROL_PREVIEW + 1 }, (_, i) => i);
    expect(NodePatrolPreviewed.safeParse({ kind: 'patrol-previewed', requestId: REQUEST, times: many }).success).toBe(
      false,
    );
  });
});

describe('Patrols elsewhere in the protocol', () => {
  it('has hello flags for running Patrols and taking them from the app', () => {
    expect(
      NodeHello.parse({ kind: 'hello', node: 'n', patrols: true, patrolsFromApp: false, patrolPreview: true }),
    ).toMatchObject({
      patrols: true,
      patrolsFromApp: false,
      patrolPreview: true,
    });
  });

  it('links a Patrol’s Quest to its run', () => {
    expect(PatrolLink.safeParse({ patrol: 'sweep', run: RUN }).success).toBe(true);
  });

  it('sends clients a Kingdom’s Patrols and a Patrol’s runs', () => {
    expect(
      HubToClient.safeParse({ kind: 'patrols', node: 'n', editable: true, patrols: [{ id: 'sweep', failures: 0 }] })
        .success,
    ).toBe(true);
    expect(
      HubToClient.safeParse({
        kind: 'patrol-runs',
        node: 'n',
        patrol: 'sweep',
        runs: [{ id: RUN, startedAt: 1, trigger: 'now', outcome: 'running' }],
      }).success,
    ).toBe(true);
  });
});
