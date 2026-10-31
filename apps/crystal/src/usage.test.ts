import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { usageFromRaw, usageFromStatusLine } from './usage.js';

// Shape recorded from the real CLI (2.1.312); the values are made up.
const rateLimitEvent = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed',
    resetsAt: 1700000000,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 0.09, resetsAt: 1700000000, status: 'allowed' },
      seven_day: { utilization: 0.04, resetsAt: 1700500000, status: 'allowed' },
    },
  },
};

describe('usageFromRaw', () => {
  it('turns a rate_limit_event into percent-used windows with millisecond reset times', () => {
    expect(usageFromRaw(rateLimitEvent)).toEqual({
      windows: [
        { id: 'five_hour', label: '5h', spanHours: 5, usedPct: 9, resetsAt: 1700000000000, status: 'allowed' },
        { id: 'seven_day', label: '7d', spanHours: 168, usedPct: 4, resetsAt: 1700500000000, status: 'allowed' },
      ],
    });
  });

  it('keeps an unknown window under its own id, and a missing reset as null', () => {
    const raw = {
      type: 'rate_limit_event',
      rate_limit_info: { unifiedWindows: { monthly: { utilization: 0.5, status: 'allowed_warning' } } },
    };
    expect(usageFromRaw(raw)).toEqual({
      windows: [{ id: 'monthly', label: 'monthly', usedPct: 50, resetsAt: null, status: 'allowed_warning' }],
    });
  });

  it('returns undefined for other lines and for a rate_limit_event without windows', () => {
    expect(usageFromRaw({ type: 'result' })).toBeUndefined();
    expect(usageFromRaw('nope')).toBeUndefined();
    expect(usageFromRaw({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })).toBeUndefined();
  });
});

describe('window lengths', () => {
  const report = (...ids: string[]) => ({
    type: 'rate_limit_event',
    rate_limit_info: {
      unifiedWindows: Object.fromEntries(ids.map((id) => [id, { utilization: 0.1, resetsAt: 0, status: 'allowed' }])),
    },
  });
  const line = readFileSync(new URL('../test/fixtures/allow.ndjson', import.meta.url), 'utf8')
    .split('\n')
    .find((l) => l.includes('"rate_limit_event"'));

  it('reads them from recorded output', () => {
    const windows = usageFromRaw(JSON.parse(line!))?.windows;
    expect(windows?.map(({ id, label, spanHours }) => ({ id, label, spanHours }))).toEqual([
      { id: 'five_hour', label: '5h', spanHours: 5 },
      { id: 'seven_day', label: '7d', spanHours: 168 },
    ]);
  });

  it('reads a plan with no five-hour window the same way', () => {
    expect(usageFromRaw(report('seven_day'))?.windows).toMatchObject([{ label: '7d', spanHours: 168 }]);
  });

  it('keeps what follows the length, so a narrower limit stays apart from the plan’s own', () => {
    expect(usageFromRaw(report('seven_day_special'))?.windows).toMatchObject([
      { id: 'seven_day_special', label: '7d special', spanHours: 168 },
    ]);
  });

  it('reads digits, and the other units', () => {
    const windows = usageFromRaw(report('30_day', 'two_week', 'one_month', 'twelve_hour'))?.windows;
    expect(windows?.map((w) => [w.label, w.spanHours])).toEqual([
      ['30d', 720],
      ['2w', 336],
      ['1mo', 720],
      ['12h', 12],
    ]);
  });

  it('passes on a window it can’t read, with no length', () => {
    const [window] = usageFromRaw(report('burst'))!.windows;
    expect(window).toMatchObject({ id: 'burst', label: 'burst' });
    expect(window).not.toHaveProperty('spanHours');
  });

  it('reads the statusline’s windows the same way', () => {
    const windows = usageFromStatusLine({
      rate_limits: { seven_day: { used_percentage: 12.5, resets_at: 1_800_000_000 } },
    })?.windows;
    expect(windows).toMatchObject([{ label: '7d', spanHours: 168 }]);
  });
});
