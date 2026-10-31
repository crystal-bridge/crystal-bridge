import type { UsageWindow } from '@crystal-bridge/protocol';
import { describe, expect, it } from 'vitest';
import { planBars } from './plan.js';

const now = 1_000_000_000_000;
const HOUR = 3_600_000;

function window(id: string, usedPct: number, spanHours?: number, extra: Partial<UsageWindow> = {}): UsageWindow {
  return {
    id,
    label: id,
    usedPct,
    resetsAt: now + HOUR,
    status: 'allowed',
    ...(spanHours === undefined ? {} : { spanHours }),
    ...extra,
  };
}

const fiveHour = (used = 30) => window('five_hour', used, 5);
const weekly = (used = 10) => window('seven_day', used, 168);

describe('planBars', () => {
  it('has no bars before a report', () => {
    expect(planBars(undefined, now)).toEqual({});
    expect(planBars([], now)).toEqual({});
  });

  it('makes the only window HP, with no second bar', () => {
    const bars = planBars([weekly(25)], now);
    expect(bars.hp).toMatchObject({ left: 75, limit: 'weekly' });
    expect(bars.stamina).toBeUndefined();
  });

  it('makes the shortest window HP and the longer one Stamina, whatever order they came in', () => {
    const bars = planBars([weekly(10), fiveHour(30)], now);
    expect(bars.hp).toMatchObject({ left: 70, limit: '5-hour' });
    expect(bars.stamina).toMatchObject({ left: 90, limit: 'weekly' });
  });

  it('shows the tightest of several longer windows as Stamina', () => {
    const narrow = window('seven_day_special', 80, 168, { label: '7d special' });
    const bars = planBars([fiveHour(), weekly(10), narrow], now);
    expect(bars.stamina).toMatchObject({ left: 20, limit: '7d special' });
  });

  it('adds no bar for a window as long as HP’s', () => {
    expect(planBars([weekly(10), window('seven_day_special', 80, 168)], now).stamina).toBeUndefined();
  });

  it('reads a report from a Kingdom too old to send spans, in the order it came', () => {
    const bars = planBars([window('five_hour', 30), window('seven_day', 10)], now);
    expect(bars.hp?.left).toBe(70);
    expect(bars.hp?.limit).toBe('five_hour');
    expect(bars.stamina?.left).toBe(90);
  });

  it('fills a bar once its window has reset, and drops the reset time', () => {
    const bars = planBars([fiveHour(90)], now + 2 * HOUR);
    expect(bars.hp).toMatchObject({ left: 100, resetsAt: null });
  });

  it('warns on a window that says so, even with room left', () => {
    expect(planBars([fiveHour(30)], now).hp?.warning).toBeUndefined();
    const warned = window('five_hour', 30, 5, { status: 'allowed_warning' });
    expect(planBars([warned], now).hp?.warning).toBe('low');
    const stopped = window('seven_day', 30, 168, { status: 'rejected' });
    expect(planBars([fiveHour(), stopped], now).stamina?.warning).toBe('out');
  });

  it('forgets a warning from a window that has reset', () => {
    const stopped = window('five_hour', 100, 5, { status: 'rejected' });
    expect(planBars([stopped], now + 2 * HOUR).hp?.warning).toBeUndefined();
  });

  it('names a window by its length', () => {
    expect(planBars([window('a', 0, 24)], now).hp?.limit).toBe('1-day');
    expect(planBars([window('a', 0, 720)], now).hp?.limit).toBe('30-day');
    expect(planBars([window('a', 0, 1)], now).hp?.limit).toBe('1-hour');
  });
});
