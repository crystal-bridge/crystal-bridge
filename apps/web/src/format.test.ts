import { describe, expect, it } from 'vitest';
import { shortWhen } from './format.js';

describe('shortWhen', () => {
  const now = new Date(2026, 10, 18, 15, 0).getTime();

  it('gives the time for today, the day for this year, and the year before that, as a mail list does', () => {
    expect(shortWhen(new Date(2026, 10, 18, 9, 5).getTime(), now, 'en-US')).toBe('9:05 AM');
    expect(shortWhen(new Date(2026, 10, 12, 9, 5).getTime(), now, 'en-US')).toBe('Nov 12');
    expect(shortWhen(new Date(2025, 10, 12, 9, 5).getTime(), now, 'en-US')).toBe('Nov 12, 2025');
  });
});
