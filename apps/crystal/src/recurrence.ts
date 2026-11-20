import type { Schedule } from '@crystal-bridge/protocol';
import { Cron } from 'croner';
import { RRuleTemporal } from 'rrule-temporal';
import { Temporal } from 'temporal-polyfill';

/**
 * The recurrence engine Scouts and Patrols share (docs/PATROLS.md, "Keep the watch"). It turns a schedule into the
 * times it gives; the run rules (jitter, catch-up, no overlap, pausing) stay with each scheduler.
 *
 * A `rule` is expanded in wall-clock time and only then placed in its zone, so daylight saving can't drop a run: a time
 * the clocks skip runs just after the gap (02:30 becomes 03:30), as calendar apps do, and a time they repeat runs once,
 * at its first passing. So an hourly rule runs once in the repeated hour, and the hour after the gap holds the gap's run.
 * A `cron` keeps croner's behaviour, which Scouts have always had.
 */
export interface Recurrence {
  /**
   * The first time the schedule gives strictly after `after`, in epoch milliseconds, or none once it has ended. Throws
   * when it can't tell, so a schedule never ends quietly by mistake.
   */
  next(after: number): number | undefined;
}

/** The finest rule a Kingdom runs. A rule every second is a mistake, not a schedule. */
const FREQUENCIES = new Set(['YEARLY', 'MONTHLY', 'WEEKLY', 'DAILY', 'HOURLY', 'MINUTELY']);
/** Daylight saving moves a wall-clock time by at most this, so a later wall time can't be an earlier instant. */
const SHIFT = { hours: 3 } as const;
/** Occurrences one `next` may look through before it gives up; a skipped day counts once, however many runs it held. */
const MAX_STEPS = 10_000;

/** The times a schedule gives after `after`, at most `count` of them, as the app's preview shows. */
export function upcoming(recurrence: Recurrence, after: number, count: number): number[] {
  const times: number[] = [];
  let from = after;
  while (times.length < count) {
    const next = recurrence.next(from);
    if (next === undefined) break;
    times.push(next);
    from = next;
  }
  return times;
}

/**
 * The text a scheduler keeps its state under, so a changed schedule starts afresh. A cron's key is the one Scouts have
 * always saved, so their state survives the move to this engine.
 */
export function scheduleKey(schedule: Schedule): string {
  if ('cron' in schedule) return `${schedule.cron}|${schedule.timezone}`;
  if ('once' in schedule) return JSON.stringify({ once: schedule.once, timezone: schedule.timezone });
  return JSON.stringify({
    rule: schedule.rule,
    start: schedule.start,
    timezone: schedule.timezone,
    except: schedule.except ?? [],
  });
}

/** A recurrence for the schedule, or why it can't run, as a line for the Scout's or Patrol's error. */
export function recurrenceOf(schedule: Schedule): Recurrence | string {
  const { timezone } = schedule;
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    return `schedule: "${timezone}" is no time zone this machine knows (try one like "America/Chicago")`;
  }
  if ('cron' in schedule) return cronOf(schedule.cron, timezone);
  if ('once' in schedule) {
    const once = wallOf(schedule.once);
    if (!once) return `schedule: once: "${schedule.once}" is no date and time`;
    const time = instantOf(once, timezone);
    return { next: (after) => (time > after ? time : undefined) };
  }
  return ruleOf(schedule.rule, schedule.start, timezone, schedule.except ?? []);
}

function cronOf(cron: string, timezone: string): Recurrence | string {
  let job: Cron;
  try {
    job = new Cron(cron.trim(), { timezone, paused: true, mode: '5-part' });
  } catch (error) {
    return `schedule: "${cron}" isn't a five-field cron: ${messageOf(error)}`;
  }
  if (!job.nextRun()) return `schedule: "${cron}" never comes round`;
  return { next: (after) => job.nextRun(new Date(after))?.getTime() };
}

/** Where a schedule's `UNTIL` stops it: a date in its zone (inclusive), a wall-clock time there, or an instant. */
type Until =
  | { kind: 'date'; date: Temporal.PlainDate }
  | { kind: 'wall'; wall: Temporal.PlainDateTime }
  | { kind: 'instant'; at: number };

function ruleOf(text: string, startText: string, timezone: string, exceptText: string[]): Recurrence | string {
  const start = wallOf(startText);
  if (!start) return `schedule: start: "${startText}" is no date and time`;
  const body = text.trim().replace(/^RRULE:/i, '');
  if (/[\r\n]|DTSTART|RRULE:|EXDATE|RDATE/i.test(body))
    return 'schedule: rule: give just the RRULE parts; the start goes in `start` and skipped days in `except`';

  const parts: string[] = [];
  let freq: string | undefined;
  let count = false;
  let until: Until | undefined;
  for (const part of body.split(';').filter(Boolean)) {
    const [rawKey = '', value = ''] = part.split('=', 2);
    const key = rawKey.toUpperCase();
    if (key === 'FREQ') freq = value.toUpperCase();
    if (key === 'COUNT') count = true;
    // A list of seconds multiplies everything else the library works out, enough to stall the Kingdom for a minute.
    if (key === 'BYSECOND') return 'schedule: rule: BYSECOND is finer than a rule runs; the finest is each minute';
    if (key === 'UNTIL') {
      const parsed = untilOf(value);
      if (!parsed) return `schedule: rule: UNTIL=${value} is no date or time`;
      until = parsed;
      continue;
    }
    parts.push(part);
  }
  if (freq === 'SECONDLY') return 'schedule: rule: FREQ=SECONDLY is finer than a rule runs; the finest is each minute';
  if (!freq || !FREQUENCIES.has(freq))
    return `schedule: rule: FREQ=${freq ?? ''} isn't one of ${[...FREQUENCIES].join(', ')}`;
  if (count && until) return 'schedule: rule: COUNT and UNTIL both end a rule; give one';

  const except = new Set<string>();
  for (const value of exceptText) {
    const wall = value.includes('T') ? wallOf(value) : undefined;
    const date = value.includes('T') ? undefined : dateOf(value);
    if (!wall && !date) return `schedule: except: "${value}" is no date or time`;
    except.add((wall ?? date)!.toString());
  }

  // A floating rule (no zone) gives wall-clock times; the library reports them in UTC, which never shifts.
  let rrule: RRuleTemporal;
  try {
    rrule = new RRuleTemporal({
      rruleString: `DTSTART:${basic(start)}\nRRULE:${parts.join(';')}`,
      temporal: Temporal,
    });
  } catch (error) {
    return `schedule: rule: ${messageOf(error)}`;
  }

  const beyond = (wall: Temporal.PlainDateTime): boolean => {
    if (!until) return false;
    if (until.kind === 'date') return Temporal.PlainDate.compare(wall.toPlainDate(), until.date) > 0;
    if (until.kind === 'wall') return Temporal.PlainDateTime.compare(wall, until.wall) > 0;
    return instantOf(wall, timezone) > until.at;
  };
  const recurrence: Recurrence = {
    next(after) {
      const afterWall = Temporal.Instant.fromEpochMilliseconds(after).toZonedDateTimeISO(timezone).toPlainDateTime();
      let cursor = afterWall.subtract(SHIFT).toZonedDateTime('UTC');
      let best: number | undefined;
      let bestWall: Temporal.PlainDateTime | undefined;
      for (let step = 0; step < MAX_STEPS; step++) {
        const found = rrule.next(cursor, false) as Temporal.ZonedDateTime | null;
        if (!found) return best;
        cursor = found;
        const wall = found.toPlainDateTime();
        if (bestWall && Temporal.PlainDateTime.compare(wall, bestWall.add(SHIFT)) > 0) return best;
        if (beyond(wall)) return best;
        if (except.has(wall.toPlainDate().toString())) {
          // Past the whole skipped day at once, so a rule every minute doesn't spend a step on each of its runs.
          const nextDay = wall.toPlainDate().add({ days: 1 }).toPlainDateTime();
          cursor = nextDay.toZonedDateTime('UTC').subtract({ nanoseconds: 1 });
          continue;
        }
        if (except.has(wall.toString())) continue;
        const time = instantOf(wall, timezone);
        if (time <= after) continue;
        if (best === undefined || time < best) best = time;
        bestWall ??= wall;
      }
      if (best !== undefined) return best;
      throw new Error(`looked through ${MAX_STEPS} times without finding the next one`);
    },
  };
  try {
    if (recurrence.next(instantOf(start, timezone) - 1) === undefined)
      return `schedule: rule: "${text}" never comes round`;
  } catch (error) {
    return `schedule: rule: "${text}" never comes round, or too rarely to find (${messageOf(error)})`;
  }
  return recurrence;
}

/** A local date-time such as `2026-12-01T09:00`, or nothing for one that doesn't exist (February 30th). */
function wallOf(text: string): Temporal.PlainDateTime | undefined {
  try {
    return Temporal.PlainDateTime.from(text, { overflow: 'reject' });
  } catch {
    return undefined;
  }
}

function dateOf(text: string): Temporal.PlainDate | undefined {
  try {
    return Temporal.PlainDate.from(text, { overflow: 'reject' });
  } catch {
    return undefined;
  }
}

function untilOf(value: string): Until | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/i.exec(value);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second, utc] = match;
  const date = dateOf(`${year}-${month}-${day}`);
  if (!date) return undefined;
  if (hour === undefined) return { kind: 'date', date };
  const wall = wallOf(`${year}-${month}-${day}T${hour}:${minute}:${second}`);
  if (!wall) return undefined;
  return utc ? { kind: 'instant', at: wall.toZonedDateTime('UTC').epochMilliseconds } : { kind: 'wall', wall };
}

/** The instant a wall-clock time means in a zone: just after a gap for a skipped time, the first passing for a repeat. */
function instantOf(wall: Temporal.PlainDateTime, timezone: string): number {
  return wall.toZonedDateTime(timezone, { disambiguation: 'compatible' }).epochMilliseconds;
}

/** RFC 5545's basic form, `20261201T090000`. */
function basic(wall: Temporal.PlainDateTime): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(wall.year, 4)}${pad(wall.month)}${pad(wall.day)}T${pad(wall.hour)}${pad(wall.minute)}${pad(wall.second)}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A schedule's next `count` times after `now`, for the Patrol form's preview, or why it gives none: the reason a file
 * with this schedule would get, or the engine giving up on a rule it can't place.
 */
export function preview(schedule: Schedule, count: number, now: number): { times: number[] } | { reason: string } {
  const recurrence = recurrenceOf(schedule);
  return typeof recurrence === 'string' ? { reason: recurrence } : previewOf(recurrence, count, now);
}

/** As `preview`, for a schedule already turned into its times: `next()` throws when it can't tell, and that's a reason. */
export function previewOf(
  recurrence: Recurrence,
  count: number,
  now: number,
): { times: number[] } | { reason: string } {
  try {
    return { times: upcoming(recurrence, now, count) };
  } catch (error) {
    return { reason: messageOf(error) };
  }
}
