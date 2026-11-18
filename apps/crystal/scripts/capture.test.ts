import { describe, expect, it } from 'vitest';
import { scrub } from './capture.js';

describe('scrub', () => {
  it('keeps when the login expires out of a fixture, but keeps the key so the shape stays pinned', () => {
    const line = JSON.stringify({ type: 'result', credential_expires_at: '2026-11-26T07:18:25.304Z', is_error: false });
    const scrubbed = JSON.parse(scrub(line, '')) as Record<string, unknown>;
    expect(scrubbed.credential_expires_at).toBe('1970-01-01T00:00:00.000Z');
    expect(scrubbed.is_error).toBe(false);
  });
});
