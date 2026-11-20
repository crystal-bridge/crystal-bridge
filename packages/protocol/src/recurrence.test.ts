import { describe, expect, it } from 'vitest';
import { recurrenceOf, type Recurrence } from './recurrence.js';
import type { Schedule } from './schedule.js';

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

function of(schedule: Schedule): Recurrence {
  const recurrence = recurrenceOf(schedule);
  if (typeof recurrence === 'string') throw new Error(recurrence);
  return recurrence;
}

/** The next `count` times after `after`, as ISO strings, so a failure reads as dates. */
const upcoming = (schedule: Schedule, after: string, count: number) => of(schedule).upcoming(at(after), count).map(iso);

const rule = (text: string, start: string, timezone = 'UTC', extra: Partial<Schedule> = {}): Schedule => ({
  rule: text,
  start,
  timezone,
  ...extra,
});

describe('cron', () => {
  it('works as croner does, in the time zone', () => {
    expect(upcoming({ cron: '0 9 * * *', timezone: 'America/Chicago' }, '2026-11-20T00:00:00Z', 2)).toEqual([
      '2026-11-20T15:00:00.000Z',
      '2026-11-21T15:00:00.000Z',
    ]);
  });

  it('runs a skipped time at the end of the jump, and a repeated one once, as croner does', () => {
    // 2027-03-14 in Chicago: 02:30 doesn't exist; croner runs it at 03:00 CDT.
    expect(upcoming({ cron: '30 2 * * *', timezone: 'America/Chicago' }, '2027-03-14T00:00:00Z', 1)).toEqual([
      '2027-03-14T08:00:00.000Z',
    ]);
    // 2026-11-01: 01:30 happens twice; it runs once.
    expect(upcoming({ cron: '30 1 * * *', timezone: 'America/Chicago' }, '2026-11-01T00:00:00Z', 2)).toEqual([
      '2026-11-01T06:30:00.000Z',
      '2026-11-02T07:30:00.000Z',
    ]);
  });

  it('is always strictly after the time asked from', () => {
    const cron = of({ cron: '0 9 * * *', timezone: 'UTC' });
    expect(iso(cron.next(at('2026-11-20T09:00:00Z'))!)).toBe('2026-11-21T09:00:00.000Z');
  });

  it('refuses a cron that never comes round, a garbled one, and a zone this machine doesn’t know', () => {
    expect(recurrenceOf({ cron: '0 0 31 2 *', timezone: 'UTC' })).toMatch(/never/);
    expect(recurrenceOf({ cron: '0 99 * * *', timezone: 'UTC' })).toMatch(/schedule/);
    expect(recurrenceOf({ cron: '0 9 * * *', timezone: 'Nowhere/Land' })).toMatch(/time zone/);
  });
});

describe('a recurrence rule', () => {
  it('runs every day at the start’s time of day, in the zone', () => {
    expect(upcoming(rule('FREQ=DAILY', '2026-12-01T09:00', 'America/Chicago'), '2026-11-01T00:00:00Z', 3)).toEqual([
      '2026-12-01T15:00:00.000Z',
      '2026-12-02T15:00:00.000Z',
      '2026-12-03T15:00:00.000Z',
    ]);
  });

  it('accepts an RRULE: prefix and parts in any case', () => {
    expect(upcoming(rule('RRULE:freq=daily;interval=2', '2026-12-01T09:00'), '2026-11-01T00:00:00Z', 2)).toEqual([
      '2026-12-01T09:00:00.000Z',
      '2026-12-03T09:00:00.000Z',
    ]);
  });

  it('runs every other Tuesday', () => {
    expect(
      upcoming(
        rule('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU', '2026-12-01T09:00', 'America/Chicago'),
        '2026-11-01T00:00:00Z',
        3,
      ),
    ).toEqual(['2026-12-01T15:00:00.000Z', '2026-12-15T15:00:00.000Z', '2026-12-29T15:00:00.000Z']);
  });

  it('treats the start as the earliest time, not as a run of its own when it doesn’t match', () => {
    // 2026-12-02 is a Wednesday: the first run is the next Tuesday.
    expect(upcoming(rule('FREQ=WEEKLY;BYDAY=TU', '2026-12-02T09:00'), '2026-11-01T00:00:00Z', 1)).toEqual([
      '2026-12-08T09:00:00.000Z',
    ]);
  });

  it('runs at several times of day with BYHOUR and BYMINUTE', () => {
    expect(upcoming(rule('FREQ=DAILY;BYHOUR=9,17;BYMINUTE=30', '2026-12-01T00:00'), '2026-12-01T00:00:00Z', 3)).toEqual(
      ['2026-12-01T09:30:00.000Z', '2026-12-01T17:30:00.000Z', '2026-12-02T09:30:00.000Z'],
    );
  });

  describe('month ends and leap days', () => {
    it('runs on the last day of each month with BYMONTHDAY=-1', () => {
      expect(upcoming(rule('FREQ=MONTHLY;BYMONTHDAY=-1', '2027-01-01T09:00'), '2027-01-01T00:00:00Z', 4)).toEqual([
        '2027-01-31T09:00:00.000Z',
        '2027-02-28T09:00:00.000Z',
        '2027-03-31T09:00:00.000Z',
        '2027-04-30T09:00:00.000Z',
      ]);
      expect(upcoming(rule('FREQ=MONTHLY;BYMONTHDAY=-1', '2028-02-01T09:00'), '2028-02-01T00:00:00Z', 1)).toEqual([
        '2028-02-29T09:00:00.000Z',
      ]);
    });

    it('skips months without the 31st, as calendars do', () => {
      expect(upcoming(rule('FREQ=MONTHLY', '2027-01-31T09:00'), '2027-01-01T00:00:00Z', 4)).toEqual([
        '2027-01-31T09:00:00.000Z',
        '2027-03-31T09:00:00.000Z',
        '2027-05-31T09:00:00.000Z',
        '2027-07-31T09:00:00.000Z',
      ]);
    });

    it('runs on the last weekday of the month with BYSETPOS', () => {
      const lastWeekday = rule('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', '2027-01-01T17:00');
      expect(upcoming(lastWeekday, '2027-01-01T00:00:00Z', 3)).toEqual([
        '2027-01-29T17:00:00.000Z',
        '2027-02-26T17:00:00.000Z',
        '2027-03-31T17:00:00.000Z',
      ]);
    });

    it('runs on the second Tuesday, and the last Friday', () => {
      expect(upcoming(rule('FREQ=MONTHLY;BYDAY=2TU', '2027-01-01T09:00'), '2027-01-01T00:00:00Z', 2)).toEqual([
        '2027-01-12T09:00:00.000Z',
        '2027-02-09T09:00:00.000Z',
      ]);
      expect(upcoming(rule('FREQ=MONTHLY;BYDAY=-1FR', '2027-01-01T09:00'), '2027-01-01T00:00:00Z', 2)).toEqual([
        '2027-01-29T09:00:00.000Z',
        '2027-02-26T09:00:00.000Z',
      ]);
    });

    it('runs a leap-day rule only in leap years', () => {
      expect(upcoming(rule('FREQ=YEARLY', '2028-02-29T09:00'), '2028-01-01T00:00:00Z', 2)).toEqual([
        '2028-02-29T09:00:00.000Z',
        '2032-02-29T09:00:00.000Z',
      ]);
    });

    it('counts a numbered weekday through the year when there is no BYMONTH, and lets BYMONTHDAY limit it', () => {
      const lastMonday = rule('FREQ=YEARLY;BYDAY=-1MO;BYMONTHDAY=25,26,27,28,29,30,31', '2027-01-01T09:00');
      expect(upcoming(lastMonday, '2027-01-01T00:00:00Z', 2)).toEqual([
        '2027-12-27T09:00:00.000Z',
        '2028-12-25T09:00:00.000Z',
      ]);
      const firstMonday = rule('FREQ=YEARLY;BYDAY=1MO;BYMONTHDAY=1,2,3,4,5,6,7', '2027-01-01T09:00');
      expect(upcoming(firstMonday, '2027-01-01T00:00:00Z', 2)).toEqual([
        '2027-01-04T09:00:00.000Z',
        '2028-01-03T09:00:00.000Z',
      ]);
    });

    it('runs yearly in the months BYMONTH names', () => {
      expect(
        upcoming(rule('FREQ=YEARLY;BYMONTH=1,7;BYMONTHDAY=1', '2027-01-01T09:00'), '2027-01-01T00:00:00Z', 3),
      ).toEqual(['2027-01-01T09:00:00.000Z', '2027-07-01T09:00:00.000Z', '2028-01-01T09:00:00.000Z']);
    });
  });

  describe('daylight saving', () => {
    it('America/Chicago: a time the spring night skips runs an hour later; a repeated time runs once', () => {
      // 2027-03-14: 02:00 CST jumps to 03:00 CDT.
      expect(upcoming(rule('FREQ=DAILY', '2027-03-13T02:30', 'America/Chicago'), '2027-03-13T00:00:00Z', 3)).toEqual([
        '2027-03-13T08:30:00.000Z',
        '2027-03-14T08:30:00.000Z',
        '2027-03-15T07:30:00.000Z',
      ]);
      // 2026-11-01: 02:00 CDT falls back to 01:00 CST, so 01:30 happens twice. The first one runs.
      expect(upcoming(rule('FREQ=DAILY', '2026-10-31T01:30', 'America/Chicago'), '2026-10-31T00:00:00Z', 3)).toEqual([
        '2026-10-31T06:30:00.000Z',
        '2026-11-01T06:30:00.000Z',
        '2026-11-02T07:30:00.000Z',
      ]);
    });

    it('Europe/Berlin: the same in both directions', () => {
      // 2027-03-28: 02:00 CET jumps to 03:00 CEST.
      expect(upcoming(rule('FREQ=DAILY', '2027-03-27T02:30', 'Europe/Berlin'), '2027-03-27T00:00:00Z', 3)).toEqual([
        '2027-03-27T01:30:00.000Z',
        '2027-03-28T01:30:00.000Z',
        '2027-03-29T00:30:00.000Z',
      ]);
      // 2026-10-25: 03:00 CEST falls back to 02:00 CET, so 02:30 happens twice.
      expect(upcoming(rule('FREQ=DAILY', '2026-10-24T02:30', 'Europe/Berlin'), '2026-10-24T00:00:00Z', 3)).toEqual([
        '2026-10-24T00:30:00.000Z',
        '2026-10-25T00:30:00.000Z',
        '2026-10-26T01:30:00.000Z',
      ]);
    });

    it('Australia/Sydney: the southern hemisphere’s changes, in October and April', () => {
      // 2026-10-04: 02:00 AEST jumps to 03:00 AEDT.
      expect(upcoming(rule('FREQ=DAILY', '2026-10-03T02:30', 'Australia/Sydney'), '2026-10-01T00:00:00Z', 3)).toEqual([
        '2026-10-02T16:30:00.000Z',
        '2026-10-03T16:30:00.000Z',
        '2026-10-04T15:30:00.000Z',
      ]);
      // 2027-04-04: 03:00 AEDT falls back to 02:00 AEST, so 02:30 happens twice.
      expect(upcoming(rule('FREQ=DAILY', '2027-04-03T02:30', 'Australia/Sydney'), '2027-04-01T00:00:00Z', 3)).toEqual([
        '2027-04-02T15:30:00.000Z',
        '2027-04-03T15:30:00.000Z',
        '2027-04-04T16:30:00.000Z',
      ]);
    });

    describe('Australia/Lord_Howe, whose clocks jump half an hour', () => {
      // 2027-10-03: 02:00 (+10:30) jumps to 02:30 (+11). 02:15 doesn't exist and lands at 02:45, after the real 02:40.
      const schedule = (extra = '') =>
        rule(`FREQ=DAILY;BYHOUR=2;BYMINUTE=15,40${extra}`, '2027-10-01T00:00', 'Australia/Lord_Howe');

      it('keeps the real time that a moved one passes', () => {
        expect(upcoming(schedule(), '2027-10-02T00:00:00Z', 2)).toEqual([
          '2027-10-02T15:40:00.000Z',
          '2027-10-02T15:45:00.000Z',
        ]);
      });

      it('counts them in time order', () => {
        expect(upcoming(schedule(';COUNT=6'), '2027-09-01T00:00:00Z', 9)).toEqual([
          '2027-09-30T15:45:00.000Z',
          '2027-09-30T16:10:00.000Z',
          '2027-10-01T15:45:00.000Z',
          '2027-10-01T16:10:00.000Z',
          '2027-10-02T15:40:00.000Z',
          '2027-10-02T15:45:00.000Z',
        ]);
      });

      it('ends at UNTIL by time, not by the order of the wall times', () => {
        const runs = upcoming(schedule(';UNTIL=20271002T154200Z'), '2027-09-01T00:00:00Z', 9);
        expect(runs).toHaveLength(5);
        expect(runs.at(-1)).toBe('2027-10-02T15:40:00.000Z');
      });
    });

    it('keeps a weekly time of day across the change', () => {
      expect(
        upcoming(rule('FREQ=WEEKLY;BYDAY=SU', '2027-03-07T09:00', 'America/Chicago'), '2027-03-01T00:00:00Z', 2),
      ).toEqual(['2027-03-07T15:00:00.000Z', '2027-03-14T14:00:00.000Z']);
    });
  });

  describe('ending it', () => {
    it('stops after UNTIL, given in UTC while the rule runs in another zone', () => {
      const daily = (until: string) => rule(`FREQ=DAILY;UNTIL=${until}`, '2026-12-01T09:00', 'America/Chicago');
      expect(upcoming(daily('20261203T150000Z'), '2026-11-01T00:00:00Z', 9)).toEqual([
        '2026-12-01T15:00:00.000Z',
        '2026-12-02T15:00:00.000Z',
        '2026-12-03T15:00:00.000Z',
      ]);
      expect(upcoming(daily('20261203T145959Z'), '2026-11-01T00:00:00Z', 9)).toHaveLength(2);
    });

    it('reads an UNTIL without Z as local time, and a date alone as the end of that day', () => {
      const daily = (until: string) => rule(`FREQ=DAILY;UNTIL=${until}`, '2026-12-01T09:00', 'America/Chicago');
      expect(upcoming(daily('20261202T090000'), '2026-11-01T00:00:00Z', 9)).toHaveLength(2);
      expect(upcoming(daily('20261202'), '2026-11-01T00:00:00Z', 9)).toHaveLength(2);
    });

    it('stops after COUNT runs, counted from the start whenever it’s asked', () => {
      const three = rule('FREQ=DAILY;COUNT=3', '2026-12-01T09:00');
      expect(upcoming(three, '2026-11-01T00:00:00Z', 9)).toHaveLength(3);
      expect(upcoming(three, '2026-12-02T10:00:00Z', 9)).toEqual(['2026-12-03T09:00:00.000Z']);
      expect(of(three).next(at('2026-12-03T09:00:00Z'))).toBeUndefined();
    });

    it('skips except dates and times; they still use up the COUNT, as in RFC 5545', () => {
      const schedule = rule('FREQ=DAILY;COUNT=4', '2026-12-01T09:00', 'UTC', {
        except: ['2026-12-02', '2026-12-03T09:00'],
      });
      expect(upcoming(schedule, '2026-11-01T00:00:00Z', 9)).toEqual([
        '2026-12-01T09:00:00.000Z',
        '2026-12-04T09:00:00.000Z',
      ]);
    });
  });

  it('finds the next run of a rule started long ago without walking every day since', () => {
    const daily = of(rule('FREQ=DAILY', '1990-01-01T09:00', 'America/Chicago'));
    const began = performance.now();
    expect(iso(daily.next(at('2026-11-20T16:00:00Z'))!)).toBe('2026-11-21T15:00:00.000Z');
    expect(performance.now() - began).toBeLessThan(50);
  });

  it('refuses what it can’t read, saying what', () => {
    const problem = (text: string, start = '2026-12-01T09:00') => recurrenceOf(rule(text, start));
    expect(problem('INTERVAL=2')).toMatch(/FREQ/);
    expect(problem('FREQ=HOURLY')).toMatch(/cron/);
    expect(problem('FREQ=DAILY;BYWEEKNO=2')).toMatch(/BYWEEKNO/);
    expect(problem('FREQ=WEEKLY;BYDAY=XX')).toMatch(/BYDAY/);
    expect(problem('FREQ=WEEKLY;BYDAY=2TU')).toMatch(/BYDAY/);
    expect(problem('FREQ=DAILY;COUNT=3;UNTIL=20270101')).toMatch(/COUNT/);
    expect(problem('FREQ=DAILY;INTERVAL=0')).toMatch(/INTERVAL/);
    expect(problem('FREQ=DAILY;FREQ=WEEKLY')).toMatch(/FREQ/);
    expect(problem('FREQ=DAILY', '2026-02-30T09:00')).toMatch(/start/);
    expect(problem('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30')).toMatch(/never/);
    expect(recurrenceOf(rule('FREQ=DAILY', '2026-12-01T09:00', 'Nowhere/Land'))).toMatch(/time zone/);
  });

  it('has no next run once it has ended, without being an error', () => {
    const ended = of(rule('FREQ=DAILY;UNTIL=20200101T000000Z', '2019-12-30T09:00'));
    expect(ended.next(at('2026-11-20T00:00:00Z'))).toBeUndefined();
  });
});

describe('once', () => {
  it('runs once, at its time in the zone', () => {
    const once = of({ once: '2026-12-04T15:00', timezone: 'America/Chicago' });
    expect(once.upcoming(at('2026-11-20T00:00:00Z'), 3).map(iso)).toEqual(['2026-12-04T21:00:00.000Z']);
    expect(once.next(at('2026-12-04T21:00:00Z'))).toBeUndefined();
  });

  it('never runs when its time has passed', () => {
    expect(of({ once: '2020-01-01T09:00', timezone: 'UTC' }).next(at('2026-11-20T00:00:00Z'))).toBeUndefined();
  });

  it('refuses a date that doesn’t exist', () => {
    expect(recurrenceOf({ once: '2026-13-01T09:00', timezone: 'UTC' })).toMatch(/once/);
  });
});
