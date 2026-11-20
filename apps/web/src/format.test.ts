import { describe, expect, it } from 'vitest';
import { scheduleText, shortWhen } from './format.js';

describe('shortWhen', () => {
  const now = new Date(2026, 10, 18, 15, 0).getTime();

  it('gives the time for today, the day for this year, and the year before that, as a mail list does', () => {
    expect(shortWhen(new Date(2026, 10, 18, 9, 5).getTime(), now, 'en-US')).toBe('9:05 AM');
    expect(shortWhen(new Date(2026, 10, 12, 9, 5).getTime(), now, 'en-US')).toBe('Nov 12');
    expect(shortWhen(new Date(2025, 10, 12, 9, 5).getTime(), now, 'en-US')).toBe('Nov 12, 2025');
  });
});

describe('scheduleText', () => {
  it('shows a cron as written, and a rule or a one-off with its start, each with its zone', () => {
    expect(scheduleText({ cron: '*/15 8-20 * * 1-5', timezone: 'America/Chicago' })).toBe(
      '*/15 8-20 * * 1-5 (America/Chicago)',
    );
    expect(
      scheduleText({ rule: 'RRULE:FREQ=WEEKLY;BYDAY=TU', start: '2026-12-01T09:00', timezone: 'America/Chicago' }),
    ).toBe('FREQ=WEEKLY;BYDAY=TU from 2026-12-01 09:00 (America/Chicago)');
    expect(scheduleText({ once: '2026-12-01T09:00', timezone: 'UTC' })).toBe('once at 2026-12-01 09:00 (UTC)');
  });
});
