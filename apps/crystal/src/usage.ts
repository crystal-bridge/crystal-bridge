import type { UsagePayload, UsageWindow } from '@crystal-bridge/protocol';

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

const COUNTS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const UNITS: Record<string, { hours: number; short: string }> = {
  hour: { hours: 1, short: 'h' },
  day: { hours: 24, short: 'd' },
  week: { hours: 168, short: 'w' },
  month: { hours: 720, short: 'mo' },
};

/**
 * A window's label and length from the engine's name for it, such as `five_hour` or `seven_day`. Whatever follows the
 * length stays in the label, since it marks a narrower limit than the plan's own. A name that doesn't start with a
 * length is passed on as it is, with none, so a new kind of window is shown rather than lost.
 */
function describeWindow(id: string): Pick<UsageWindow, 'label' | 'spanHours'> {
  const match = /^([a-z]+|\d+)_(hour|day|week|month)s?(?:_(.+))?$/.exec(id);
  const unit = match && UNITS[match[2]!];
  const count = match && (/^\d+$/.test(match[1]!) ? Number(match[1]) : COUNTS.indexOf(match[1]!) + 1);
  if (!match || !unit || !count) return { label: id };
  const scope = match[3] ? ` ${match[3].replaceAll('_', ' ')}` : '';
  return { label: `${count}${unit.short}${scope}`, spanHours: count * unit.hours };
}

/**
 * Translates the CLI's `rate_limit_event` line into the engine-neutral `usage` payload. The CLI
 * reports `utilization` as a 0-1 fraction and `resetsAt` in epoch seconds (recorded 2026-10-28,
 * CLI 2.1.312). Anything else, or a report with no windows, yields undefined.
 */
export function usageFromRaw(raw: unknown): UsagePayload | undefined {
  if (!isObj(raw) || raw.type !== 'rate_limit_event' || !isObj(raw.rate_limit_info)) return undefined;
  const windows = raw.rate_limit_info.unifiedWindows;
  if (!isObj(windows)) return undefined;

  const out: UsageWindow[] = [];
  for (const [id, window] of Object.entries(windows)) {
    if (!isObj(window) || typeof window.utilization !== 'number') continue;
    out.push({
      id,
      ...describeWindow(id),
      usedPct: Math.round(window.utilization * 1000) / 10,
      resetsAt: typeof window.resetsAt === 'number' && window.resetsAt > 0 ? window.resetsAt * 1000 : null,
      status: typeof window.status === 'string' ? window.status : 'unknown',
    });
  }
  return out.length > 0 ? { windows: out } : undefined;
}

/**
 * The same payload from a statusline command's documented input (code.claude.com/docs/en/statusline):
 * `rate_limits.<window>.used_percentage` (0-100) and `resets_at` (epoch seconds), for an interactive session, which
 * has no `rate_limit_event` lines. Absent until the session's first API response.
 */
export function usageFromStatusLine(input: unknown): UsagePayload | undefined {
  if (!isObj(input) || !isObj(input.rate_limits)) return undefined;
  const out: UsageWindow[] = [];
  for (const [id, window] of Object.entries(input.rate_limits)) {
    if (!isObj(window) || typeof window.used_percentage !== 'number') continue;
    out.push({
      id,
      ...describeWindow(id),
      usedPct: Math.round(window.used_percentage * 10) / 10,
      resetsAt: typeof window.resets_at === 'number' && window.resets_at > 0 ? window.resets_at * 1000 : null,
      status: 'unknown',
    });
  }
  return out.length > 0 ? { windows: out } : undefined;
}
