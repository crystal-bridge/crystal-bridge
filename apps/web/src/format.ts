import type { Schedule } from '@crystal-bridge/protocol';

/** Short formats shared by the Stats panel, battle results and Boards. */

/** 1234 -> 1.2k, 124000 -> 124k, 1000000 -> 1M */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** 3725000 -> "1h 2m", 754000 -> "12m 34s", 9000 -> "9s" */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

/** 3400000 -> "3.4 MB", 52000 -> "52 KB" */
export function bytes(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} KB`;
  return `${n} B`;
}

/** 0.0421 -> "$0.04"; amounts under a cent keep more digits so a cheap turn doesn't read as free. */
export function money(usd: number): string {
  return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** Gold: one coin per US cent, grouped by locale (1.18 -> "118", 100.82 -> "10,082"); under a cent reads "<1". */
export function goldText(usd: number, locale?: string): string {
  const coins = Math.round(usd * 100);
  if (usd > 0 && coins === 0) return '<1';
  return new Intl.NumberFormat(locale).format(coins);
}

/** "9:05 AM" today, "Nov 12" this year, "Nov 12, 2025" before: a date as a mail list shows it. */
export function shortWhen(at: number, now: number, locale?: string): string {
  const date = new Date(at);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  }
  const sameYear = date.getFullYear() === today.getFullYear();
  return date.toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** A Scout's or Patrol's schedule in one line, in its own time zone: a cron as written, a rule or a one-off with its start. */
export function scheduleText(schedule: Schedule): string {
  const local = (time: string) => time.replace('T', ' ');
  if ('cron' in schedule) return `${schedule.cron} (${schedule.timezone})`;
  if ('once' in schedule) return `once at ${local(schedule.once)} (${schedule.timezone})`;
  return `${schedule.rule.replace(/^RRULE:/i, '')} from ${local(schedule.start)} (${schedule.timezone})`;
}
