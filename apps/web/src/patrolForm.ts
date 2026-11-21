import type { Effort, Engine, ListedPatrol, PatrolManifest, PermissionMode, Schedule } from '@crystal-bridge/protocol';

/**
 * The Patrol form's model (docs/PATROLS.md, Edit from the app): a draft the form edits, the `patrol.json` it saves, and
 * a schedule in plain words for the Watchtower's cards. Whether a schedule makes sense stays the Kingdom's call: the
 * form shows its preview and its reasons.
 */

export type Every = 'minute' | 'hour' | 'day' | 'week' | 'month';
export type Weekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';
export const WEEKDAYS: { value: Weekday; label: string }[] = [
  { value: 'MO', label: 'Mon' },
  { value: 'TU', label: 'Tue' },
  { value: 'WE', label: 'Wed' },
  { value: 'TH', label: 'Thu' },
  { value: 'FR', label: 'Fri' },
  { value: 'SA', label: 'Sat' },
  { value: 'SU', label: 'Sun' },
];

/** The Repeat builder: a rule in the shapes calendar apps offer, starting from a date and time. */
export interface RepeatDraft {
  every: Every;
  interval: number;
  /** Weekly: the days it runs on; none means the start's own day. */
  days: Weekday[];
  /** Monthly: the day of the month, or -1 for the last. */
  monthDay: number;
  /** The start, in the schedule's zone; for minutes and hours the time anchors the steps. */
  date: string;
  time: string;
  end: 'never' | 'on' | 'after';
  until: string;
  count: number;
  /** Days skipped, kept from the file: the form doesn't edit them. */
  except?: string[];
}

export type ScheduleForm = 'repeat' | 'rule' | 'cron' | 'once';

export interface ScheduleDraft {
  form: ScheduleForm;
  repeat: RepeatDraft;
  /** A rule the builder can't show, as text, with its start and skipped days. */
  rule: string;
  ruleStart: string;
  ruleExcept?: string[];
  cron: string;
  once: string;
  timezone: string;
}

const FREQ: Record<Every, string> = {
  minute: 'MINUTELY',
  hour: 'HOURLY',
  day: 'DAILY',
  week: 'WEEKLY',
  month: 'MONTHLY',
};
const EVERY = Object.fromEntries(Object.entries(FREQ).map(([every, freq]) => [freq, every])) as Record<string, Every>;
const WEEKDAY_CODES = new Set<string>(WEEKDAYS.map((day) => day.value));

/** Today's date in a zone, as `2026-11-20`. */
function today(now: number, zone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}

const compact = (date: string) => date.replaceAll('-', '');

/** The schedule a draft gives, as `patrol.json` takes it. */
export function scheduleOf(draft: ScheduleDraft): Schedule {
  const timezone = draft.timezone.trim();
  if (draft.form === 'cron') return { cron: draft.cron.trim(), timezone };
  if (draft.form === 'once') return { once: draft.once, timezone };
  if (draft.form === 'rule')
    return {
      rule: draft.rule.trim().replace(/^RRULE:/i, ''),
      start: draft.ruleStart,
      timezone,
      ...(draft.ruleExcept ? { except: draft.ruleExcept } : {}),
    };
  const repeat = draft.repeat;
  const parts = [`FREQ=${FREQ[repeat.every]}`];
  if (repeat.interval > 1) parts.push(`INTERVAL=${repeat.interval}`);
  if (repeat.every === 'week' && repeat.days.length > 0)
    parts.push(`BYDAY=${WEEKDAYS.filter((day) => repeat.days.includes(day.value)).map((day) => day.value)}`);
  if (repeat.every === 'month') parts.push(`BYMONTHDAY=${repeat.monthDay}`);
  if (repeat.end === 'after') parts.push(`COUNT=${repeat.count}`);
  if (repeat.end === 'on') parts.push(`UNTIL=${compact(repeat.until)}`);
  return {
    rule: parts.join(';'),
    start: `${repeat.date}T${repeat.time}`,
    timezone,
    ...(repeat.except ? { except: repeat.except } : {}),
  };
}

/** A rule's parts, or undefined if it repeats one or isn't `KEY=value;...`. */
function partsOf(rule: string): Map<string, string> | undefined {
  const parts = new Map<string, string>();
  for (const part of rule.replace(/^RRULE:/i, '').split(';')) {
    const match = /^([A-Z]+)=(.+)$/i.exec(part.trim());
    if (!match || parts.has(match[1]!.toUpperCase())) return undefined;
    parts.set(match[1]!.toUpperCase(), match[2]!.toUpperCase());
  }
  return parts;
}

/** A rule in the builder's terms, or undefined if the builder can't show it all. */
function repeatOf(rule: string, start: string): Omit<RepeatDraft, 'except'> | undefined {
  const parts = partsOf(rule);
  const at = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::00)?$/.exec(start);
  if (!parts || !at) return undefined;
  const every = EVERY[parts.get('FREQ') ?? ''];
  if (!every) return undefined;
  const repeat: Omit<RepeatDraft, 'except'> = {
    every,
    interval: 1,
    days: [],
    monthDay: 1,
    date: at[1]!,
    time: at[2]!,
    end: 'never',
    until: at[1]!,
    count: 10,
  };
  for (const [key, value] of parts) {
    if (key === 'FREQ') continue;
    if (key === 'INTERVAL' && /^[1-9]\d{0,3}$/.test(value)) repeat.interval = Number(value);
    else if (key === 'BYDAY' && every === 'week' && value.split(',').every((day) => WEEKDAY_CODES.has(day)))
      repeat.days = value.split(',') as Weekday[];
    else if (key === 'BYMONTHDAY' && every === 'month' && /^(-1|[1-9]|[12]\d|3[01])$/.test(value))
      repeat.monthDay = Number(value);
    else if (key === 'COUNT' && /^[1-9]\d{0,3}$/.test(value)) {
      repeat.end = 'after';
      repeat.count = Number(value);
    } else if (key === 'UNTIL' && /^\d{8}$/.test(value)) {
      repeat.end = 'on';
      repeat.until = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`;
    } else return undefined;
  }
  // A monthly rule without a day runs on the start's day, which the builder doesn't offer.
  if (every === 'month' && !parts.has('BYMONTHDAY')) return undefined;
  return repeat;
}

/** The form's schedule for a Patrol's, or a new one: daily at 09:00 from today in the browser's zone. */
export function scheduleDraftOf(schedule: Schedule | undefined, now: number, zone: string): ScheduleDraft {
  const date = today(now, schedule?.timezone ?? zone);
  const draft: ScheduleDraft = {
    form: 'repeat',
    repeat: {
      every: 'day',
      interval: 1,
      days: [],
      monthDay: 1,
      date,
      time: '09:00',
      end: 'never',
      until: date,
      count: 10,
    },
    rule: '',
    ruleStart: `${date}T09:00`,
    cron: '0 9 * * *',
    once: `${date}T09:00`,
    timezone: schedule?.timezone ?? zone,
  };
  if (!schedule) return draft;
  if ('cron' in schedule) return { ...draft, form: 'cron', cron: schedule.cron };
  if ('once' in schedule) return { ...draft, form: 'once', once: schedule.once };
  const repeat = repeatOf(schedule.rule, schedule.start);
  if (repeat) return { ...draft, repeat: { ...repeat, ...(schedule.except ? { except: schedule.except } : {}) } };
  return {
    ...draft,
    form: 'rule',
    rule: schedule.rule,
    ruleStart: schedule.start,
    ...(schedule.except ? { ruleExcept: schedule.except } : {}),
  };
}

/** One-click schedules: each fills the Repeat builder. */
export const PRESETS: { label: string; repeat: Partial<RepeatDraft> }[] = [
  { label: 'Every hour', repeat: { every: 'hour', interval: 1, time: '00:00' } },
  { label: 'Daily at 03:00', repeat: { every: 'day', interval: 1, time: '03:00' } },
  { label: 'Daily at 09:00', repeat: { every: 'day', interval: 1, time: '09:00' } },
  {
    label: 'Weekdays at 09:00',
    repeat: { every: 'week', interval: 1, days: ['MO', 'TU', 'WE', 'TH', 'FR'], time: '09:00' },
  },
  { label: 'Mondays at 09:00', repeat: { every: 'week', interval: 1, days: ['MO'], time: '09:00' } },
  { label: 'First of the month', repeat: { every: 'month', interval: 1, monthDay: 1, time: '09:00' } },
];

const DAY_LABEL = Object.fromEntries(WEEKDAYS.map((day) => [day.value, day.label])) as Record<Weekday, string>;
const CRON_DAYS: Weekday[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const pad = (value: string) => value.padStart(2, '0');
const plural = (count: number, one: string) => (count === 1 ? one : `${count} ${one}s`);

function weekdayOf(date: string): Weekday {
  return CRON_DAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
}

function daysWords(days: readonly Weekday[]): string {
  const set = days.join(',');
  if (set === 'MO,TU,WE,TH,FR') return 'Weekdays';
  if (set === 'SA,SU') return 'Weekends';
  return `Every ${days.map((day) => DAY_LABEL[day]).join(', ')}`;
}

function repeatWords(repeat: Omit<RepeatDraft, 'except'>): string {
  const { interval: n, time } = repeat;
  let words: string;
  if (repeat.every === 'minute') words = n === 1 ? 'Every minute' : `Every ${n} minutes`;
  else if (repeat.every === 'hour')
    words = n === 1 ? `Every hour at :${time.slice(3)}` : `Every ${n} hours from ${time}`;
  else if (repeat.every === 'day') words = n === 1 ? `Daily at ${time}` : `Every ${n} days at ${time}`;
  else if (repeat.every === 'week') {
    const days = repeat.days.length > 0 ? repeat.days : [weekdayOf(repeat.date)];
    words =
      n === 1
        ? `${daysWords(days)} at ${time}`
        : `Every ${n} weeks on ${days.map((day) => DAY_LABEL[day]).join(', ')} at ${time}`;
  } else {
    const day = repeat.monthDay === -1 ? 'the last day' : `day ${repeat.monthDay}`;
    words = n === 1 ? `Monthly on ${day} at ${time}` : `Every ${n} months on ${day} at ${time}`;
  }
  if (repeat.end === 'after') words += repeat.count === 1 ? ', once' : `, ${repeat.count} times`;
  if (repeat.end === 'on') words += `, until ${repeat.until}`;
  return words;
}

function cronWords(cron: string): string | undefined {
  const [minute, hour, dayOfMonth, month, dayOfWeek, ...rest] = cron.trim().split(/\s+/);
  if (rest.length > 0 || dayOfMonth !== '*' || month !== '*') return undefined;
  const every = /^\*\/([1-9]\d?)$/.exec(minute ?? '');
  // A step restarts each hour, so only one that divides the hour runs every N minutes.
  if (every && hour === '*' && dayOfWeek === '*')
    return 60 % Number(every[1]) === 0 ? `Every ${plural(Number(every[1]), 'minute')}` : undefined;
  if (!/^\d{1,2}$/.test(minute ?? '')) return undefined;
  if (hour === '*' && dayOfWeek === '*') return `Every hour at :${pad(minute!)}`;
  if (!/^\d{1,2}$/.test(hour ?? '')) return undefined;
  const time = `${pad(hour!)}:${pad(minute!)}`;
  if (dayOfWeek === '*') return `Daily at ${time}`;
  if (dayOfWeek === '1-5') return `Weekdays at ${time}`;
  if (/^[0-7]$/.test(dayOfWeek ?? '')) return `Every ${DAY_LABEL[CRON_DAYS[Number(dayOfWeek)]!]} at ${time}`;
  return undefined;
}

/** A schedule in plain words, without its zone: "Weekdays at 09:00", or its own text when that's clearer. */
export function scheduleWords(schedule: Schedule): string {
  const local = (time: string) => time.replace('T', ' ');
  if ('cron' in schedule) return cronWords(schedule.cron) ?? `cron ${schedule.cron}`;
  if ('once' in schedule) {
    const [date, time] = schedule.once.split('T');
    return `Once, ${date} at ${time!.slice(0, 5)}`;
  }
  const repeat = repeatOf(schedule.rule, schedule.start);
  return repeat ? repeatWords(repeat) : `${schedule.rule.replace(/^RRULE:/i, '')} from ${local(schedule.start)}`;
}

/** A folder name for a new Patrol from its name: lowercase words and dashes, numbered past the ones taken. */
export function patrolIdFrom(name: string, taken: readonly string[]): string {
  const trim = (id: string) => id.replace(/^-+|-+$/g, '');
  const base =
    trim(
      trim(
        name
          .toLowerCase()
          .normalize('NFKD')
          .replace(/[^a-z0-9]+/g, '-'),
      ).slice(0, 64),
    ) || 'patrol';
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n += 1) {
    const id = `${trim(base.slice(0, 63 - String(n).length))}-${n}`;
    if (!taken.includes(id)) return id;
  }
}

/** What the form edits. Empty strings leave a field to the Kingdom's default. */
export interface PatrolDraft {
  name: string;
  project: string;
  promptText: string;
  /** The prompt file an existing Patrol names, kept until its text is replaced here. */
  promptFile?: string | undefined;
  mode: PermissionMode | '';
  effort: Effort | '';
  engine: Engine | '';
  worktree: boolean;
  waitForYou: string;
  catchUp: string;
  /** Kept from the file: the form doesn't edit Boards yet. */
  board?: string | undefined;
  schedule: ScheduleDraft;
}

export function newPatrolDraft(now: number, zone: string, mode: PermissionMode): PatrolDraft {
  return {
    name: '',
    project: '',
    promptText: '',
    mode,
    effort: '',
    engine: '',
    worktree: false,
    waitForYou: '',
    catchUp: '',
    schedule: scheduleDraftOf(undefined, now, zone),
  };
}

/**
 * A new Patrol's starting point from a Board item ("Patrol this"): what its Quest action would start with, and the
 * Board to report back to.
 */
export interface PatrolSeed {
  name: string;
  project: string;
  promptText: string;
  mode?: PermissionMode | undefined;
  worktree?: boolean | undefined;
  board: string;
}

/** A new Patrol's draft from a seed: its name cut to what a Patrol's name holds, and the rest as new ones start. */
export function seededDraft(seed: PatrolSeed, now: number, zone: string, mode: PermissionMode): PatrolDraft {
  return {
    ...newPatrolDraft(now, zone, seed.mode ?? mode),
    name: seed.name.trim().slice(0, 80),
    project: seed.project,
    promptText: seed.promptText,
    worktree: seed.worktree ?? false,
    board: seed.board,
  };
}

/** The form's draft of a Quest Patrol, to edit it. */
export function draftOf(patrol: ListedPatrol, now: number, zone: string): PatrolDraft {
  const manifest = patrol.manifest;
  const quest = manifest?.quest;
  return {
    name: manifest?.name ?? patrol.id,
    project: quest?.project ?? '',
    promptText: quest?.promptText ?? '',
    promptFile: quest?.prompt,
    mode: quest?.mode ?? '',
    effort: quest?.effort ?? '',
    engine: quest?.engine ?? '',
    worktree: quest?.worktree ?? false,
    waitForYou: quest?.waitForYou ?? '',
    catchUp: manifest?.catchUp ?? '',
    board: manifest?.board,
    schedule: scheduleDraftOf(manifest?.schedule, now, zone),
  };
}

/** The `patrol.json` a draft saves; `PatrolManifest` checks it before it goes. */
export function manifestOf(draft: PatrolDraft): PatrolManifest {
  return {
    name: draft.name.trim(),
    schedule: scheduleOf(draft.schedule),
    quest: {
      project: draft.project.trim(),
      ...(draft.promptFile ? { prompt: draft.promptFile } : { promptText: draft.promptText.trim() }),
      ...(draft.mode ? { mode: draft.mode } : {}),
      ...(draft.effort ? { effort: draft.effort } : {}),
      ...(draft.engine ? { engine: draft.engine } : {}),
      ...(draft.worktree ? { worktree: true } : {}),
      ...(draft.waitForYou ? { waitForYou: draft.waitForYou } : {}),
    },
    ...(draft.board ? { board: draft.board } : {}),
    ...(draft.catchUp ? { catchUp: draft.catchUp } : {}),
  };
}
