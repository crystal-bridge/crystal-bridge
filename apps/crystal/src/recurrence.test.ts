import type { Schedule } from '@crystal-bridge/protocol';
import { describe, expect, it } from 'vitest';
import { preview, previewOf, recurrenceOf, scheduleKey, upcoming, type Recurrence } from './recurrence.js';

const at = (iso: string) => Date.parse(iso);
const iso = (times: number[]) => times.map((time) => new Date(time).toISOString());

function engine(schedule: Schedule): Recurrence {
  const recurrence = recurrenceOf(schedule);
  if (typeof recurrence === 'string') throw new Error(recurrence);
  return recurrence;
}

function errorOf(schedule: Schedule): string {
  const recurrence = recurrenceOf(schedule);
  if (typeof recurrence !== 'string') throw new Error('expected the schedule to be refused');
  return recurrence;
}

const chicago = (rule: string, start: string, except?: string[]): Schedule => ({
  rule,
  start,
  timezone: 'America/Chicago',
  ...(except ? { except } : {}),
});

describe('rule schedules', () => {
  it('gives every other Tuesday from the start, in its zone', () => {
    const times = upcoming(
      engine(chicago('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU', '2026-12-01T09:00')),
      at('2026-11-20T00:00Z'),
      3,
    );
    expect(iso(times)).toEqual(['2026-12-01T15:00:00.000Z', '2026-12-15T15:00:00.000Z', '2026-12-29T15:00:00.000Z']);
  });

  it('takes an RRULE: prefix', () => {
    const times = upcoming(engine(chicago('RRULE:FREQ=DAILY', '2026-12-01T09:00')), at('2026-11-20T00:00Z'), 1);
    expect(iso(times)).toEqual(['2026-12-01T15:00:00.000Z']);
  });

  it('gives the last weekday of each month', () => {
    const schedule: Schedule = {
      rule: 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1',
      start: '2026-11-01T17:00',
      timezone: 'Europe/London',
    };
    expect(iso(upcoming(engine(schedule), at('2026-11-01T00:00Z'), 3))).toEqual([
      '2026-11-30T17:00:00.000Z',
      '2026-12-31T17:00:00.000Z',
      '2027-01-29T17:00:00.000Z',
    ]);
  });

  it('gives the last day of each month, and skips months without the start day', () => {
    const last: Schedule = { rule: 'FREQ=MONTHLY;BYMONTHDAY=-1', start: '2027-01-31T18:00', timezone: 'UTC' };
    expect(iso(upcoming(engine(last), at('2027-01-01T00:00Z'), 3))).toEqual([
      '2027-01-31T18:00:00.000Z',
      '2027-02-28T18:00:00.000Z',
      '2027-03-31T18:00:00.000Z',
    ]);
    const plain: Schedule = { rule: 'FREQ=MONTHLY', start: '2027-01-31T18:00', timezone: 'UTC' };
    expect(iso(upcoming(engine(plain), at('2027-01-01T00:00Z'), 3))).toEqual([
      '2027-01-31T18:00:00.000Z',
      '2027-03-31T18:00:00.000Z',
      '2027-05-31T18:00:00.000Z',
    ]);
  });

  it('keeps a leap day for leap years', () => {
    const schedule: Schedule = { rule: 'FREQ=YEARLY', start: '2028-02-29T12:00', timezone: 'UTC' };
    expect(iso(upcoming(engine(schedule), at('2028-01-01T00:00Z'), 2))).toEqual([
      '2028-02-29T12:00:00.000Z',
      '2032-02-29T12:00:00.000Z',
    ]);
  });

  it('runs a time the clocks skip just after the gap, as calendar apps do', () => {
    const times = upcoming(engine(chicago('FREQ=DAILY', '2026-03-06T02:30')), at('2026-03-07T00:00Z'), 3);
    // 02:30 CST, then 03:30 CDT on the night 02:00-03:00 doesn't exist, then 02:30 CDT.
    expect(iso(times)).toEqual(['2026-03-07T08:30:00.000Z', '2026-03-08T08:30:00.000Z', '2026-03-09T07:30:00.000Z']);
  });

  it('runs a time the clocks repeat once, at its first passing', () => {
    const times = upcoming(engine(chicago('FREQ=DAILY', '2026-10-30T01:30')), at('2026-10-31T00:00Z'), 3);
    expect(iso(times)).toEqual(['2026-10-31T06:30:00.000Z', '2026-11-01T06:30:00.000Z', '2026-11-02T07:30:00.000Z']);
  });

  it('never gives the same time twice across a gap', () => {
    const times = upcoming(engine(chicago('FREQ=HOURLY', '2026-03-08T00:00')), at('2026-03-08T00:00Z'), 4);
    expect(iso(times)).toEqual([
      '2026-03-08T06:00:00.000Z',
      '2026-03-08T07:00:00.000Z',
      '2026-03-08T08:00:00.000Z',
      '2026-03-08T09:00:00.000Z',
    ]);
  });

  it('ends at an UNTIL given in UTC, including a run at that instant', () => {
    // 09:00 in Chicago in December is 15:00 UTC.
    const upTo = (until: string) =>
      upcoming(engine(chicago(`FREQ=DAILY;UNTIL=${until}`, '2026-12-01T09:00')), at('2026-11-20T00:00Z'), 10);
    expect(upTo('20261205T150000Z')).toHaveLength(5);
    expect(upTo('20261205T145959Z')).toHaveLength(4);
  });

  it('ends at an UNTIL given as a local date or date-time', () => {
    const upTo = (until: string) =>
      upcoming(engine(chicago(`FREQ=DAILY;UNTIL=${until}`, '2026-12-01T09:00')), at('2026-11-20T00:00Z'), 10);
    expect(upTo('20261205')).toHaveLength(5);
    expect(upTo('20261205T090000')).toHaveLength(5);
    expect(upTo('20261205T085959')).toHaveLength(4);
  });

  it('stops after COUNT runs, and skips the except dates without giving more', () => {
    const counted = { rule: 'FREQ=DAILY;COUNT=3', start: '2026-12-01T09:00', timezone: 'UTC' } as const;
    expect(upcoming(engine(counted), at('2026-11-20T00:00Z'), 10)).toHaveLength(3);
    const skipping: Schedule = { ...counted, except: ['2026-12-02', '2026-12-03T09:00'] };
    expect(iso(upcoming(engine(skipping), at('2026-11-20T00:00Z'), 10))).toEqual(['2026-12-01T09:00:00.000Z']);
  });

  it('gives the next time strictly after the one asked', () => {
    const recurrence = engine(chicago('FREQ=DAILY', '2026-12-01T09:00'));
    expect(recurrence.next(at('2026-12-01T15:00Z'))).toBe(at('2026-12-02T15:00Z'));
    expect(recurrence.next(at('2026-12-01T14:59:59Z'))).toBe(at('2026-12-01T15:00Z'));
  });

  it('finds the next time quickly for a frequent rule that started long ago', () => {
    const schedule: Schedule = { rule: 'FREQ=MINUTELY;INTERVAL=5', start: '2024-01-01T00:00', timezone: 'UTC' };
    const began = performance.now();
    expect(engine(schedule).next(at('2026-11-20T10:02Z'))).toBe(at('2026-11-20T10:05Z'));
    expect(performance.now() - began).toBeLessThan(5000);
  });

  it('has nothing next once the rule has ended', () => {
    expect(engine(chicago('FREQ=DAILY;COUNT=2', '2026-01-01T09:00')).next(at('2026-11-20T00:00Z'))).toBeUndefined();
  });

  it('refuses rules it cannot run', () => {
    expect(errorOf(chicago('FREQ=SOMETIMES', '2026-12-01T09:00'))).toMatch(/FREQ/);
    expect(errorOf(chicago('FREQ=SECONDLY', '2026-12-01T09:00'))).toMatch(/SECONDLY/);
    expect(errorOf(chicago('FREQ=DAILY;COUNT=3;UNTIL=20261205', '2026-12-01T09:00'))).toMatch(/COUNT.*UNTIL/);
    expect(errorOf(chicago('DTSTART:20261201T090000\nRRULE:FREQ=DAILY', '2026-12-01T09:00'))).toMatch(/start/);
    expect(errorOf(chicago('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30', '2026-12-01T09:00'))).toMatch(/never comes round/);
    expect(errorOf(chicago('FREQ=DAILY', '2026-02-30T09:00'))).toMatch(/start/);
    expect(errorOf({ rule: 'FREQ=DAILY', start: '2026-12-01T09:00', timezone: 'Mars/Olympus' })).toMatch(/time zone/);
    expect(errorOf(chicago('FREQ=DAILY;UNTIL=20261301', '2026-12-01T09:00'))).toMatch(/UNTIL=20261301/);
    // RFC 5545 has no UNTIL with a numeric offset: UTC with Z, or a time in the schedule's zone.
    expect(errorOf(chicago('FREQ=DAILY;UNTIL=20261205T150000+0100', '2026-12-01T09:00'))).toMatch(/UNTIL/);
    expect(errorOf(chicago('FREQ=DAILY', '2026-12-01T09:00', ['nope']))).toMatch(/except: "nope"/);
  });

  it('refuses runs finer than a minute, however the rule asks for them', () => {
    expect(errorOf(chicago('FREQ=MINUTELY;BYSECOND=0,30', '2026-12-01T09:00'))).toMatch(/BYSECOND/);
  });

  it('refuses a rule that asks for every second at once, rather than stalling the Kingdom working it out', () => {
    const sixty = Array.from({ length: 60 }, (_, unit) => unit).join(',');
    const began = performance.now();
    expect(errorOf(chicago(`FREQ=HOURLY;BYSECOND=${sixty};BYMINUTE=${sixty}`, '2026-12-01T09:00'))).toMatch(/BYSECOND/);
    expect(performance.now() - began).toBeLessThan(1000);
  });

  it('works out a busy rule without seconds quickly', () => {
    const hours = Array.from({ length: 24 }, (_, hour) => hour).join(',');
    const minutes = Array.from({ length: 60 }, (_, minute) => minute).join(',');
    const rule = `FREQ=YEARLY;BYHOUR=${hours};BYMINUTE=${minutes};BYSETPOS=-1`;
    const began = performance.now();
    expect(engine(chicago(rule, '2026-12-01T09:00')).next(at('2026-12-01T00:00Z'))).toBe(at('2026-12-02T05:59Z'));
    expect(performance.now() - began).toBeLessThan(5000);
  });

  it('looks past a long run of skipped days', () => {
    const except = Array.from({ length: 8 }, (_, day) => `2026-12-0${day + 1}`);
    const schedule: Schedule = { rule: 'FREQ=MINUTELY', start: '2026-11-30T23:00', timezone: 'UTC', except };
    expect(engine(schedule).next(at('2026-11-30T23:59Z'))).toBe(at('2026-12-09T00:00Z'));
  });

  it('runs an hourly rule once in the hour the clocks repeat, at its first passing', () => {
    const times = upcoming(engine(chicago('FREQ=HOURLY', '2026-11-01T00:30')), at('2026-11-01T00:00Z'), 4);
    expect(iso(times)).toEqual([
      '2026-11-01T05:30:00.000Z',
      '2026-11-01T06:30:00.000Z',
      '2026-11-01T08:30:00.000Z',
      '2026-11-01T09:30:00.000Z',
    ]);
  });

  it('follows daylight saving in the southern hemisphere too', () => {
    const sydney = (start: string): Schedule => ({ rule: 'FREQ=DAILY', start, timezone: 'Australia/Sydney' });
    // Clocks go forward at 02:00 on 2026-10-04 (AEST +10 to AEDT +11): 02:30 runs at 03:30.
    expect(iso(upcoming(engine(sydney('2026-10-03T02:30')), at('2026-10-02T00:00Z'), 2))).toEqual([
      '2026-10-02T16:30:00.000Z',
      '2026-10-03T16:30:00.000Z',
    ]);
    // Clocks go back at 03:00 on 2027-04-04: 02:30 runs once, at its first passing (AEDT).
    expect(iso(upcoming(engine(sydney('2027-04-03T02:30')), at('2027-04-02T00:00Z'), 2))).toEqual([
      '2027-04-02T15:30:00.000Z',
      '2027-04-03T15:30:00.000Z',
    ]);
  });
});

describe('cron schedules', () => {
  it('gives the next time in its zone', () => {
    const recurrence = engine({ cron: '30 3 * * *', timezone: 'Europe/Berlin' });
    expect(recurrence.next(at('2026-11-20T00:00Z'))).toBe(at('2026-11-20T02:30Z'));
  });

  it('runs a time the clocks skip at the end of the gap, as Scouts always have', () => {
    const recurrence = engine({ cron: '30 2 * * *', timezone: 'America/Chicago' });
    expect(recurrence.next(at('2026-03-08T00:00Z'))).toBe(at('2026-03-08T08:00Z'));
  });

  it('runs a time the clocks repeat once', () => {
    const times = upcoming(engine({ cron: '30 1 * * *', timezone: 'America/Chicago' }), at('2026-11-01T00:00Z'), 2);
    expect(iso(times)).toEqual(['2026-11-01T06:30:00.000Z', '2026-11-02T07:30:00.000Z']);
  });

  it('refuses a cron that isn’t one, or never comes round', () => {
    expect(errorOf({ cron: '61 * * * *', timezone: 'UTC' })).toMatch(/five-field cron/);
    expect(errorOf({ cron: '0 0 30 2 *', timezone: 'UTC' })).toMatch(/never comes round/);
    expect(errorOf({ cron: '0 0 * * *', timezone: 'Mars/Olympus' })).toMatch(/time zone/);
  });

  it('keeps the key Scouts saved their state under', () => {
    expect(scheduleKey({ cron: '*/15 * * * *', timezone: 'UTC' })).toBe('*/15 * * * *|UTC');
  });
});

describe('one-off schedules', () => {
  it('fires once, then has nothing next', () => {
    const recurrence = engine({ once: '2026-12-01T09:00', timezone: 'America/Chicago' });
    expect(recurrence.next(at('2026-11-20T00:00Z'))).toBe(at('2026-12-01T15:00Z'));
    expect(recurrence.next(at('2026-12-01T15:00Z'))).toBeUndefined();
  });

  it('runs a time the clocks skip just after the gap', () => {
    expect(engine({ once: '2026-03-08T02:30', timezone: 'America/Chicago' }).next(0)).toBe(at('2026-03-08T08:30Z'));
  });

  it('refuses a date that doesn’t exist', () => {
    expect(errorOf({ once: '2026-02-30T09:00', timezone: 'UTC' })).toMatch(/once/);
  });

  it('keeps different schedules under different keys', () => {
    const keys = new Set(
      [
        { once: '2026-12-01T09:00', timezone: 'UTC' },
        { once: '2026-12-01T09:00', timezone: 'America/Chicago' },
        { rule: 'FREQ=DAILY', start: '2026-12-01T09:00', timezone: 'UTC' },
        { rule: 'FREQ=DAILY', start: '2026-12-01T09:00', timezone: 'UTC', except: ['2026-12-02'] },
      ].map((schedule) => scheduleKey(schedule)),
    );
    expect(keys.size).toBe(4);
  });
});

describe('preview', () => {
  it('gives the next times after now, fewer once the schedule ends', () => {
    expect(preview({ cron: '0 9 * * *', timezone: 'UTC' }, 2, at('2026-11-20T10:00:00Z'))).toEqual({
      times: [at('2026-11-21T09:00:00Z'), at('2026-11-22T09:00:00Z')],
    });
    expect(preview({ once: '2026-12-01T09:00', timezone: 'UTC' }, 5, at('2026-11-20T10:00:00Z'))).toEqual({
      times: [at('2026-12-01T09:00:00Z')],
    });
  });

  it('says why a schedule gives no times, in the words a file would get', () => {
    expect(preview({ cron: '0 9 * * *', timezone: 'Mars/Base' }, 3, 0)).toEqual({
      reason: expect.stringMatching(/no time zone/),
    });
  });

  it('says a rule that never comes round, as a file with it would hear', () => {
    const never = chicago('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30', '2026-01-01T09:00');
    expect(preview(never, 3, at('2026-11-20T10:00:00Z'))).toEqual({
      reason: expect.stringMatching(/never comes round/),
    });
  });

  it('turns an engine that gives up partway into a reason, not a throw', () => {
    let calls = 0;
    const givesUp: Recurrence = {
      next: (after) => {
        if (++calls > 1) throw new Error('looked through 10000 times without finding the next one');
        return after + 1;
      },
    };
    expect(previewOf(givesUp, 3, 0)).toEqual({ reason: 'looked through 10000 times without finding the next one' });
  });
});
