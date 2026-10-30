import { describe, expect, it } from 'vitest';
import { createJoinCodes } from './join.js';

describe('join codes', () => {
  it('trades a code once for the node it was made for', () => {
    const codes = createJoinCodes();
    const { code } = codes.issue('node-a');
    expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(codes.redeem(code)).toBe('node-a');
    expect(codes.redeem(code)).toBeUndefined();
  });

  it('refuses an unknown code', () => {
    const codes = createJoinCodes();
    codes.issue('node-a');
    expect(codes.redeem('nope')).toBeUndefined();
  });

  it('refuses a code after it expires', () => {
    let time = 1000;
    const codes = createJoinCodes({ now: () => time, ttlMs: 500 });
    const { code, expiresAt } = codes.issue('node-a');
    expect(expiresAt).toBe(1500);
    time = 1501;
    expect(codes.redeem(code)).toBeUndefined();
  });

  it('keeps one live code per node: a new one replaces the old', () => {
    const codes = createJoinCodes();
    const first = codes.issue('node-a').code;
    const second = codes.issue('node-a').code;
    expect(codes.redeem(first)).toBeUndefined();
    expect(codes.redeem(second)).toBe('node-a');
  });
});
