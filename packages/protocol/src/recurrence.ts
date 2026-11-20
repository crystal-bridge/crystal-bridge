import { Cron } from 'croner';
import type { Schedule } from './schedule.js';

/**
 * When a schedule comes round. Shared by the Kingdom, which runs Scouts and Patrols on it, and the app, which shows the
 * next few times before a schedule is saved. Imported as `@crystal-bridge/protocol/recurrence`, apart from the rest of
 * the protocol, so the hub, which never schedules anything, doesn't load croner.
 */
export interface Recurrence {
  /** The first time strictly after `after` (epoch milliseconds), or undefined when it never comes again. */
  next(after: number): number | undefined;
  /** Up to `count` times strictly after `after`, in order. */
  upcoming(after: number, count: number): number[];
}

/**
 * Reads a schedule, or says what's wrong with it, in words for its owner. A `cron` runs as croner reads it, unchanged.
 * A `rule` is the part of RFC 5545 a calendar app writes: FREQ of DAILY, WEEKLY, MONTHLY or YEARLY with INTERVAL,
 * COUNT, UNTIL, WKST and the BYMONTH, BYMONTHDAY, BYDAY, BYHOUR, BYMINUTE and BYSETPOS parts. Wall-clock times follow
 * the zone: a time a spring night skips runs as far after it as the clocks jumped (02:30 runs at 03:30, as calendar apps
 * do), and a time an autumn night repeats runs once, the first time.
 */
export function recurrenceOf(schedule: Schedule): Recurrence | string {
  const { timezone } = schedule;
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    return `schedule: "${timezone}" is no time zone this machine knows (try one like "America/Chicago")`;
  }
  if (schedule.cron !== undefined) return cronRecurrence(schedule.cron, timezone);
  if (schedule.once !== undefined) {
    const wall = readLocal(schedule.once);
    if (!wall) return `schedule: once "${schedule.once}" isn't a real date and time`;
    const when = instantOf(timezone, wall);
    return listed((after) => (when > after ? when : undefined));
  }
  if (schedule.rule !== undefined && schedule.start !== undefined) {
    const start = readLocal(schedule.start);
    if (!start) return `schedule: start "${schedule.start}" isn't a real date and time`;
    const rule = readRule(schedule.rule, timezone);
    if (typeof rule === 'string') return `schedule: ${rule}`;
    const except = new Set(schedule.except ?? []);
    for (const day of except)
      if (!readLocal(day.length === 10 ? `${day}T00:00` : day)) return `schedule: except "${day}" isn't a real date`;
    const recurrence = ruleRecurrence(rule, start, timezone, except);
    if (recurrence.next(instantOf(timezone, start) - 1) === undefined)
      return `schedule: "${schedule.rule}" never comes round`;
    return recurrence;
  }
  return 'schedule: give exactly one of cron, rule and once';
}

function listed(next: (after: number) => number | undefined): Recurrence {
  return {
    next,
    upcoming(after, count) {
      const times: number[] = [];
      for (let from = after; times.length < count;) {
        const time = next(from);
        if (time === undefined) break;
        times.push(time);
        from = time;
      }
      return times;
    },
  };
}

function cronRecurrence(cron: string, timezone: string): Recurrence | string {
  let job: Cron;
  try {
    job = new Cron(cron.trim(), { timezone, paused: true, mode: '5-part' });
  } catch (error) {
    return `schedule: "${cron}" isn't a five-field cron: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!job.nextRun()) return `schedule: "${cron}" never comes round`;
  return listed((after) => job.nextRun(new Date(after))?.getTime());
}

// Wall-clock time in a zone.

const DAY = 86_400_000;

interface Wall {
  y: number;
  /** 1 to 12. */
  mo: number;
  d: number;
  h: number;
  mi: number;
}

/** `2026-12-01T09:00` as a wall time, or undefined when no such date or time exists. */
function readLocal(text: string): Wall | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text);
  if (!match) return undefined;
  const [y, mo, d, h, mi] = match.slice(1).map(Number) as [number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo) || h > 23 || mi > 59) return undefined;
  return { y, mo, d, h, mi };
}

const daysIn = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
/** 0 is Sunday. */
const weekdayOf = (y: number, mo: number, d: number) => new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
/** Days since 1970-01-01, for counting whole days and weeks. */
const dayNumber = (y: number, mo: number, d: number) => Date.UTC(y, mo - 1, d) / DAY;
function fromDayNumber(day: number): { y: number; mo: number; d: number } {
  const date = new Date(day * DAY);
  return { y: date.getUTCFullYear(), mo: date.getUTCMonth() + 1, d: date.getUTCDate() };
}
const wallKey = (wall: Wall) => wall.y * 1e8 + wall.mo * 1e6 + wall.d * 1e4 + wall.h * 100 + wall.mi;
const pad = (n: number) => String(n).padStart(2, '0');
const dateText = (wall: Wall) => `${wall.y}-${pad(wall.mo)}-${pad(wall.d)}`;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  let format = formatters.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timezone, format);
  }
  return format;
}

/** The wall time at an instant, as a UTC timestamp of those same numbers. */
function wallStamp(timezone: string, instant: number): number {
  const parts: Record<string, number> = {};
  for (const part of formatter(timezone).formatToParts(new Date(instant)))
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
}

function wallAt(timezone: string, instant: number): Wall {
  const date = new Date(wallStamp(timezone, instant));
  return {
    y: date.getUTCFullYear(),
    mo: date.getUTCMonth() + 1,
    d: date.getUTCDate(),
    h: date.getUTCHours(),
    mi: date.getUTCMinutes(),
  };
}

/** How far the zone's clocks are ahead of UTC at an instant. */
const offsetAt = (timezone: string, instant: number) => {
  const whole = Math.floor(instant / 1000) * 1000;
  return wallStamp(timezone, whole) - whole;
};

/**
 * The instant a wall time names. A repeated time is the first of the two; a skipped one is read with the offset before
 * the jump, so it lands as far after the jump as the clocks moved (RFC 5545 3.3.5, and Temporal's "compatible").
 */
function instantOf(timezone: string, wall: Wall): number {
  const stamp = Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi);
  const before = offsetAt(timezone, stamp - DAY);
  const after = offsetAt(timezone, stamp + DAY);
  const fits = [...new Set([before, after])]
    .map((offset) => stamp - offset)
    .filter((instant) => wallStamp(timezone, instant) === stamp);
  return fits.length ? Math.min(...fits) : stamp - before;
}

// RFC 5545 recurrence rules.

type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
interface ByDay {
  /** The nth such weekday in the month or year, from the end when negative; every one when absent. */
  n?: number;
  /** 0 is Sunday. */
  weekday: number;
}
interface Rule {
  freq: Freq;
  interval: number;
  count?: number;
  /** The last instant a run may fall on. */
  until?: number;
  /** 0 is Sunday. */
  weekStart: number;
  byMonth?: number[];
  byMonthDay?: number[];
  byDay?: ByDay[];
  byHour?: number[];
  byMinute?: number[];
  bySetPos?: number[];
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const PARTS = new Set([
  'FREQ',
  'INTERVAL',
  'COUNT',
  'UNTIL',
  'WKST',
  'BYMONTH',
  'BYMONTHDAY',
  'BYDAY',
  'BYHOUR',
  'BYMINUTE',
  'BYSETPOS',
]);

function numbers(name: string, value: string, low: number, high: number, zero = true): number[] | string {
  const list = value.split(',').map((item) => (/^[+-]?\d+$/.test(item) ? Number(item) : NaN));
  if (list.some((n) => Number.isNaN(n) || n < low || n > high || (!zero && n === 0)))
    return `${name}=${value} needs numbers from ${low} to ${high}${zero ? '' : ', not 0'}`;
  return list;
}

/** Reads a rule, or says what's wrong with it. */
function readRule(text: string, timezone: string): Rule | string {
  const parts = new Map<string, string>();
  for (const piece of text
    .trim()
    .replace(/^RRULE:/i, '')
    .split(';')) {
    if (!piece) continue;
    const [rawName, value] = piece.split('=', 2) as [string, string | undefined];
    const name = rawName.trim().toUpperCase();
    if (!PARTS.has(name)) return `the rule's ${name} part isn't supported (use ${[...PARTS].join(', ')})`;
    if (parts.has(name)) return `the rule names ${name} twice`;
    if (!value) return `the rule's ${name} has no value`;
    parts.set(name, value.trim().toUpperCase());
  }
  const freq = parts.get('FREQ');
  if (!freq) return 'the rule names no FREQ';
  if (freq === 'HOURLY' || freq === 'MINUTELY' || freq === 'SECONDLY')
    return `FREQ=${freq} isn't supported: use a cron for runs more often than daily`;
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return `FREQ=${freq} isn't a frequency`;
  const rule: Rule = { freq: freq as Freq, interval: 1, weekStart: 1 };

  const interval = parts.get('INTERVAL');
  if (interval !== undefined) {
    const n = numbers('INTERVAL', interval, 1, 1000);
    if (typeof n === 'string' || n.length !== 1) return typeof n === 'string' ? n : 'INTERVAL takes one number';
    rule.interval = n[0]!;
  }
  const count = parts.get('COUNT');
  const until = parts.get('UNTIL');
  if (count !== undefined && until !== undefined) return 'a rule ends by COUNT or UNTIL, not both';
  if (count !== undefined) {
    const n = numbers('COUNT', count, 1, 100_000);
    if (typeof n === 'string' || n.length !== 1) return typeof n === 'string' ? n : 'COUNT takes one number';
    rule.count = n[0]!;
  }
  if (until !== undefined) {
    const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(until);
    const wall = match && readLocal(`${match[1]}-${match[2]}-${match[3]}T${match[4] ?? '00'}:${match[5] ?? '00'}`);
    if (!match || !wall) return `UNTIL=${until} isn't a date like 20261231 or 20261231T235959Z`;
    if (match[7]) rule.until = Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, Number(match[6]));
    else if (match[4]) rule.until = instantOf(timezone, wall) + Number(match[6]) * 1000;
    else {
      // A date alone runs to the end of that day.
      const next = fromDayNumber(dayNumber(wall.y, wall.mo, wall.d) + 1);
      rule.until = instantOf(timezone, { ...next, h: 0, mi: 0 }) - 1;
    }
  }
  const weekStart = parts.get('WKST');
  if (weekStart !== undefined) {
    if (!WEEKDAYS.includes(weekStart)) return `WKST=${weekStart} isn't a weekday like MO`;
    rule.weekStart = WEEKDAYS.indexOf(weekStart);
  }

  for (const [name, key, low, high, zero] of [
    ['BYMONTH', 'byMonth', 1, 12, true],
    ['BYMONTHDAY', 'byMonthDay', -31, 31, false],
    ['BYHOUR', 'byHour', 0, 23, true],
    ['BYMINUTE', 'byMinute', 0, 59, true],
    ['BYSETPOS', 'bySetPos', -366, 366, false],
  ] as const) {
    const value = parts.get(name);
    if (value === undefined) continue;
    const list = numbers(name, value, low, high, zero);
    if (typeof list === 'string') return list;
    rule[key] = [...new Set(list)];
  }
  if (rule.byMonthDay && rule.freq === 'WEEKLY') return 'BYMONTHDAY doesn’t go with FREQ=WEEKLY';

  const byDay = parts.get('BYDAY');
  if (byDay !== undefined) {
    const days: ByDay[] = [];
    for (const item of byDay.split(',')) {
      const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(item);
      if (!match) return `BYDAY=${byDay} needs weekdays like MO,WE or 2TU`;
      const n = match[1] === undefined ? undefined : Number(match[1]);
      if (n !== undefined) {
        if (rule.freq !== 'MONTHLY' && rule.freq !== 'YEARLY')
          return `BYDAY=${byDay}: a numbered weekday goes with FREQ=MONTHLY or YEARLY`;
        if (n === 0 || Math.abs(n) > 53) return `BYDAY=${byDay} has a number out of range`;
      }
      days.push({ ...(n !== undefined ? { n } : {}), weekday: WEEKDAYS.indexOf(match[2]!) });
    }
    rule.byDay = days;
  }
  if (rule.bySetPos && !rule.byDay && !rule.byMonthDay && !rule.byMonth && !rule.byHour && !rule.byMinute)
    return 'BYSETPOS needs another BY part to choose from';
  return rule;
}

/** Days of a month (1-based) that a MONTHLY or YEARLY rule picks in it. */
function daysInMonth(rule: Rule, y: number, mo: number, startDay: number): number[] {
  const length = daysIn(y, mo);
  let days: number[] | undefined;
  if (rule.byMonthDay)
    days = rule.byMonthDay.map((n) => (n > 0 ? n : length + 1 + n)).filter((d) => d >= 1 && d <= length);
  if (rule.byDay) {
    const picked = new Set<number>();
    for (const { n, weekday } of rule.byDay) {
      const matching: number[] = [];
      for (let d = 1; d <= length; d++) if (weekdayOf(y, mo, d) === weekday) matching.push(d);
      if (n === undefined) for (const d of matching) picked.add(d);
      else {
        const d = matching[n > 0 ? n - 1 : matching.length + n];
        if (d !== undefined) picked.add(d);
      }
    }
    days = days ? days.filter((d) => picked.has(d)) : [...picked];
  }
  if (!days) days = startDay <= length ? [startDay] : [];
  return [...new Set(days)].sort((a, b) => a - b);
}

/** The dates a rule picks in its `k`th period after the start's, before times of day and BYSETPOS. */
function datesOf(rule: Rule, start: Wall, k: number): { y: number; mo: number; d: number }[] {
  const step = k * rule.interval;
  switch (rule.freq) {
    case 'DAILY': {
      const date = fromDayNumber(dayNumber(start.y, start.mo, start.d) + step);
      if (rule.byMonth && !rule.byMonth.includes(date.mo)) return [];
      if (rule.byMonthDay) {
        const length = daysIn(date.y, date.mo);
        if (!rule.byMonthDay.some((n) => (n > 0 ? n : length + 1 + n) === date.d)) return [];
      }
      if (rule.byDay && !rule.byDay.some((day) => day.weekday === weekdayOf(date.y, date.mo, date.d))) return [];
      return [date];
    }
    case 'WEEKLY': {
      const startDay = dayNumber(start.y, start.mo, start.d);
      const weekBegins = startDay - ((weekdayOf(start.y, start.mo, start.d) - rule.weekStart + 7) % 7) + 7 * step;
      const weekdays = rule.byDay?.map((day) => day.weekday) ?? [weekdayOf(start.y, start.mo, start.d)];
      const dates = [];
      for (let i = 0; i < 7; i++) {
        const date = fromDayNumber(weekBegins + i);
        if (!weekdays.includes(weekdayOf(date.y, date.mo, date.d))) continue;
        if (rule.byMonth && !rule.byMonth.includes(date.mo)) continue;
        dates.push(date);
      }
      return dates;
    }
    case 'MONTHLY': {
      const index = start.y * 12 + (start.mo - 1) + step;
      const y = Math.floor(index / 12);
      const mo = (index % 12) + 1;
      if (rule.byMonth && !rule.byMonth.includes(mo)) return [];
      return daysInMonth(rule, y, mo, start.d).map((d) => ({ y, mo, d }));
    }
    case 'YEARLY': {
      const y = start.y + step;
      if (rule.byDay && !rule.byMonth && !rule.byMonthDay) {
        // Weekdays counted through the whole year, such as 20MO.
        const dates: { y: number; mo: number; d: number }[] = [];
        const first = dayNumber(y, 1, 1);
        const length = dayNumber(y + 1, 1, 1) - first;
        for (const { n, weekday } of rule.byDay) {
          const matching = [];
          for (let i = 0; i < length; i++) {
            const date = fromDayNumber(first + i);
            if (weekdayOf(date.y, date.mo, date.d) === weekday) matching.push(date);
          }
          if (n === undefined) dates.push(...matching);
          else {
            const date = matching[n > 0 ? n - 1 : matching.length + n];
            if (date) dates.push(date);
          }
        }
        return dates.sort((a, b) => dayNumber(a.y, a.mo, a.d) - dayNumber(b.y, b.mo, b.d));
      }
      const months = rule.byMonth ?? (rule.byMonthDay ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [start.mo]);
      return [...months]
        .sort((a, b) => a - b)
        .flatMap((mo) => daysInMonth(rule, y, mo, start.d).map((d) => ({ y, mo, d })));
    }
  }
}

/** The wall times a rule picks in its `k`th period, in order, BYSETPOS applied. */
function wallsOf(rule: Rule, start: Wall, k: number): Wall[] {
  const hours = [...(rule.byHour ?? [start.h])].sort((a, b) => a - b);
  const minutes = [...(rule.byMinute ?? [start.mi])].sort((a, b) => a - b);
  const walls = datesOf(rule, start, k).flatMap((date) =>
    hours.flatMap((h) => minutes.map((mi) => ({ ...date, h, mi }))),
  );
  if (!rule.bySetPos) return walls;
  const chosen = rule.bySetPos
    .map((n) => walls[n > 0 ? n - 1 : walls.length + n])
    .filter((wall): wall is Wall => wall !== undefined);
  return [...new Map(chosen.map((wall) => [wallKey(wall), wall])).values()].sort((a, b) => wallKey(a) - wallKey(b));
}

/** How many whole periods lie between the start and a later wall time, so a search can begin near it. */
function periodsBetween(rule: Rule, start: Wall, later: Wall): number {
  switch (rule.freq) {
    case 'DAILY':
      return dayNumber(later.y, later.mo, later.d) - dayNumber(start.y, start.mo, start.d);
    case 'WEEKLY':
      return Math.floor((dayNumber(later.y, later.mo, later.d) - dayNumber(start.y, start.mo, start.d)) / 7);
    case 'MONTHLY':
      return later.y * 12 + later.mo - (start.y * 12 + start.mo);
    case 'YEARLY':
      return later.y - start.y;
  }
}

/** Periods searched past the time asked about before deciding a rule never comes round again: a century of years. */
const SEARCH: Record<Freq, number> = { DAILY: 36_600, WEEKLY: 5_300, MONTHLY: 1_200, YEARLY: 100 };

function ruleRecurrence(rule: Rule, start: Wall, timezone: string, except: Set<string>): Recurrence {
  const startAt = instantOf(timezone, start);
  const skipped = (wall: Wall) =>
    except.has(dateText(wall)) || except.has(`${dateText(wall)}T${pad(wall.h)}:${pad(wall.mi)}`);
  return listed((after) => {
    // COUNT counts from the start, so only a rule without one may begin its search near `after`.
    const first =
      rule.count === undefined && after > startAt
        ? Math.max(0, Math.floor(periodsBetween(rule, start, wallAt(timezone, after)) / rule.interval) - 1)
        : 0;
    const limit = first + Math.ceil(SEARCH[rule.freq] / rule.interval) + 1;
    let counted = 0;
    let last = -Infinity;
    for (let k = first; k <= limit; k++) {
      for (const wall of wallsOf(rule, start, k)) {
        const when = instantOf(timezone, wall);
        if (when < startAt || when <= last) continue;
        if (rule.until !== undefined && when > rule.until) return undefined;
        last = when;
        counted++;
        if (rule.count !== undefined && counted > rule.count) return undefined;
        if (when > after && !skipped(wall)) return when;
      }
    }
    return undefined;
  });
}
