import { describe, expect, it } from 'vitest';
import { usageFromRaw } from './usage.js';

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
        { id: 'five_hour', label: '5h', usedPct: 9, resetsAt: 1700000000000, status: 'allowed' },
        { id: 'seven_day', label: '7d', usedPct: 4, resetsAt: 1700500000000, status: 'allowed' },
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
