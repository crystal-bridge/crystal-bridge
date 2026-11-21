import type { ListedPatrol, Schedule } from '@crystal-bridge/protocol';
import { describe, expect, it } from 'vitest';
import {
  draftOf,
  manifestOf,
  newPatrolDraft,
  patrolIdFrom,
  PRESETS,
  scheduleDraftOf,
  scheduleOf,
  scheduleWords,
  type RepeatDraft,
  type ScheduleDraft,
} from './patrolForm.js';

const NOW = Date.parse('2026-11-20T21:40:00Z');
const ruleOf = (draft: ScheduleDraft) => (scheduleOf(draft) as { rule: string }).rule;

const repeat = (extra: Partial<RepeatDraft>): ScheduleDraft => {
  const base = scheduleDraftOf(undefined, NOW, 'America/Chicago');
  return { ...base, form: 'repeat', repeat: { ...base.repeat, ...extra } };
};

describe('scheduleOf', () => {
  it('turns the Repeat builder into a rule whose start carries the time', () => {
    expect(scheduleOf(repeat({ every: 'week', interval: 2, days: ['TU'], date: '2026-12-01', time: '09:00' }))).toEqual(
      { rule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU', start: '2026-12-01T09:00', timezone: 'America/Chicago' },
    );
    expect(scheduleOf(repeat({ every: 'day', interval: 1, date: '2026-11-21', time: '03:30' }))).toEqual({
      rule: 'FREQ=DAILY',
      start: '2026-11-21T03:30',
      timezone: 'America/Chicago',
    });
    expect(ruleOf(repeat({ every: 'minute', interval: 15, date: '2026-11-21', time: '08:00' }))).toBe(
      'FREQ=MINUTELY;INTERVAL=15',
    );
  });

  it('gives a month day, the last day, and an end by date or count', () => {
    expect(ruleOf(repeat({ every: 'month', monthDay: -1, end: 'after', count: 6 }))).toBe(
      'FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=6',
    );
    expect(ruleOf(repeat({ every: 'month', monthDay: 15, end: 'on', until: '2027-06-30' }))).toBe(
      'FREQ=MONTHLY;BYMONTHDAY=15;UNTIL=20270630',
    );
  });

  it('keeps skipped days, and passes cron, once and a raw rule through', () => {
    const kept = repeat({ every: 'day', except: ['2026-12-25'] });
    expect(scheduleOf(kept)).toMatchObject({ except: ['2026-12-25'] });
    const base = scheduleDraftOf(undefined, NOW, 'UTC');
    expect(scheduleOf({ ...base, form: 'cron', cron: ' 0 9 * * 1-5 ' })).toEqual({
      cron: '0 9 * * 1-5',
      timezone: 'UTC',
    });
    expect(scheduleOf({ ...base, form: 'once', once: '2026-12-01T09:00' })).toEqual({
      once: '2026-12-01T09:00',
      timezone: 'UTC',
    });
    expect(
      scheduleOf({
        ...base,
        form: 'rule',
        rule: 'RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1',
        ruleStart: '2026-12-01T09:00',
      }),
    ).toEqual({ rule: 'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1', start: '2026-12-01T09:00', timezone: 'UTC' });
  });
});

describe('scheduleDraftOf', () => {
  it('starts a new schedule daily at 09:00 from today, in the given zone', () => {
    const draft = scheduleDraftOf(undefined, NOW, 'America/Chicago');
    expect(draft.form).toBe('repeat');
    expect(draft.timezone).toBe('America/Chicago');
    expect(draft.repeat).toMatchObject({ every: 'day', interval: 1, date: '2026-11-20', time: '09:00', end: 'never' });
  });

  it('reads a rule the builder can show back into it, and round-trips', () => {
    const schedule: Schedule = {
      rule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;UNTIL=20270101',
      start: '2026-12-01T09:00',
      timezone: 'Europe/Berlin',
    };
    const draft = scheduleDraftOf(schedule, NOW, 'UTC');
    expect(draft.form).toBe('repeat');
    expect(draft.repeat).toMatchObject({
      every: 'week',
      interval: 2,
      days: ['TU', 'TH'],
      date: '2026-12-01',
      time: '09:00',
      end: 'on',
      until: '2027-01-01',
    });
    expect(scheduleOf(draft)).toEqual(schedule);
  });

  it('keeps a rule the builder can’t show as its text', () => {
    const schedule: Schedule = { rule: 'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1', start: '2026-12-01T09:00', timezone: 'UTC' };
    const draft = scheduleDraftOf(schedule, NOW, 'UTC');
    expect(draft.form).toBe('rule');
    expect(scheduleOf(draft)).toEqual(schedule);
  });

  it('reads cron and once', () => {
    expect(scheduleDraftOf({ cron: '30 3 * * *', timezone: 'UTC' }, NOW, 'UTC')).toMatchObject({
      form: 'cron',
      cron: '30 3 * * *',
    });
    expect(scheduleDraftOf({ once: '2026-12-01T09:00', timezone: 'UTC' }, NOW, 'UTC')).toMatchObject({
      form: 'once',
      once: '2026-12-01T09:00',
    });
  });
});

describe('PRESETS', () => {
  it('fill the builder with common schedules', () => {
    const weekdays = PRESETS.find((preset) => preset.label === 'Weekdays at 09:00')!;
    expect(ruleOf(repeat(weekdays.repeat))).toBe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
  });
});

describe('scheduleWords', () => {
  const words = (schedule: Partial<Schedule> & Record<string, unknown>) =>
    scheduleWords({ timezone: 'UTC', ...schedule } as Schedule);

  it('says a builder-shaped rule in plain words', () => {
    expect(words({ rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', start: '2026-11-20T09:00' })).toBe('Weekdays at 09:00');
    expect(words({ rule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU', start: '2026-12-01T09:00' })).toBe(
      'Every 2 weeks on Tue at 09:00',
    );
    expect(words({ rule: 'FREQ=DAILY', start: '2026-11-20T03:30' })).toBe('Daily at 03:30');
    expect(words({ rule: 'FREQ=MINUTELY;INTERVAL=15', start: '2026-11-20T00:00' })).toBe('Every 15 minutes');
    expect(words({ rule: 'FREQ=HOURLY', start: '2026-11-20T00:30' })).toBe('Every hour at :30');
    expect(words({ rule: 'FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=6', start: '2026-11-20T18:00' })).toBe(
      'Monthly on the last day at 18:00, 6 times',
    );
    expect(words({ rule: 'FREQ=MONTHLY;BYMONTHDAY=1;UNTIL=20270630', start: '2026-11-20T09:00' })).toBe(
      'Monthly on day 1 at 09:00, until 2027-06-30',
    );
  });

  it('says common cron shapes and a one-off, and falls back to the text', () => {
    expect(words({ cron: '0 9 * * 1-5' })).toBe('Weekdays at 09:00');
    expect(words({ cron: '30 3 * * *' })).toBe('Daily at 03:30');
    expect(words({ cron: '*/10 * * * *' })).toBe('Every 10 minutes');
    expect(words({ cron: '0 9 * * 2' })).toBe('Every Tue at 09:00');
    expect(words({ cron: '0 9-17 * * 1-5' })).toBe('cron 0 9-17 * * 1-5');
    expect(words({ once: '2026-12-01T09:00' })).toBe('Once, 2026-12-01 at 09:00');
    expect(words({ rule: 'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1', start: '2026-12-01T09:00' })).toBe(
      'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1 from 2026-12-01 09:00',
    );
  });
});

describe('patrolIdFrom', () => {
  it('makes a folder name from the name, and steps past ones taken', () => {
    expect(patrolIdFrom('Fortnightly dependency sweep!', [])).toBe('fortnightly-dependency-sweep');
    expect(patrolIdFrom('Sweep', ['sweep', 'sweep-2'])).toBe('sweep-3');
    expect(patrolIdFrom('   ', [])).toBe('patrol');
    expect(patrolIdFrom('x'.repeat(100), []).length).toBeLessThanOrEqual(64);
  });
});

describe('manifestOf and draftOf', () => {
  it('makes a Quest Patrol with its prompt in the manifest, leaving unset fields to the Kingdom', () => {
    const draft = {
      ...newPatrolDraft(NOW, 'UTC', 'auto'),
      name: 'Nightly triage',
      project: '~/code/app',
      promptText: 'Triage new issues.',
    };
    expect(manifestOf(draft)).toEqual({
      name: 'Nightly triage',
      schedule: { rule: 'FREQ=DAILY', start: '2026-11-20T09:00', timezone: 'UTC' },
      quest: { project: '~/code/app', promptText: 'Triage new issues.', mode: 'auto' },
    });
  });

  it('keeps what the form doesn’t show when editing: a prompt file, a Board, skipped days', () => {
    const patrol: ListedPatrol = {
      id: 'sweep',
      manifest: {
        name: 'Sweep',
        schedule: { rule: 'FREQ=DAILY', start: '2026-11-20T09:00', timezone: 'UTC', except: ['2026-12-25'] },
        board: 'issues',
        catchUp: 'never',
        quest: { project: '~/code/app', prompt: 'sweep.md', mode: 'acceptEdits', worktree: true, waitForYou: '1h' },
      },
    };
    const draft = draftOf(patrol, NOW, 'UTC');
    expect(draft.promptFile).toBe('sweep.md');
    expect(manifestOf(draft)).toEqual(patrol.manifest);
  });

  it('swaps a prompt file for text when the text is replaced', () => {
    const patrol: ListedPatrol = {
      id: 'sweep',
      manifest: {
        name: 'Sweep',
        schedule: { cron: '0 9 * * *', timezone: 'UTC' },
        quest: { project: '~/code/app', prompt: 'sweep.md' },
      },
    };
    const draft = { ...draftOf(patrol, NOW, 'UTC'), promptFile: undefined, promptText: 'New words.' };
    expect(manifestOf(draft).quest).toEqual({ project: '~/code/app', promptText: 'New words.' });
  });
});
