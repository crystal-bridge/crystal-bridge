import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { accessTokens, cookieHeader, tailscaleServe } from './auth.js';

const from = (login?: string) => ({ headers: login ? { 'tailscale-user-login': login } : {} }) as FastifyRequest;

describe('tailscaleServe', () => {
  const auth = tailscaleServe(['Me@Example.com']);

  it('knows an allowed login, whatever its case', () => {
    expect(auth.identify(from('me@EXAMPLE.com'))).toBe('me@example.com');
  });

  it('knows nobody else, and nobody without the header', () => {
    expect(auth.identify(from('you@example.com'))).toBeUndefined();
    expect(auth.identify(from())).toBeUndefined();
  });
});

describe('accessTokens', () => {
  const auth = accessTokens({ verify: (token) => (token === 'good' ? 'phone' : undefined) });
  const request = (headers: Record<string, string>) => ({ headers }) as unknown as FastifyRequest;

  it('knows a token from the session cookie, among other cookies', () => {
    expect(auth.identify(request({ cookie: 'theme=dark; cb_session=good; other=1' }))).toBe('phone');
  });

  it('knows a token from a bearer header, for scripts', () => {
    expect(auth.identify(request({ authorization: 'Bearer good' }))).toBe('phone');
  });

  it('knows nobody without a good token', () => {
    expect(auth.identify(request({ cookie: 'cb_session=bad' }))).toBeUndefined();
    expect(auth.identify(request({}))).toBeUndefined();
  });

  it('ignores identity headers entirely, so no proxy can be spoofed', () => {
    expect(auth.identify(request({ 'tailscale-user-login': 'me@example.com' }))).toBeUndefined();
  });

  it('lets the app shell load, so there is a login page to show', () => {
    expect(auth.publicApp).toBe(true);
    expect(tailscaleServe(['a']).publicApp).toBeUndefined();
  });

  it('checks a token for logging in', () => {
    expect(auth.login?.('good')).toBe('phone');
    expect(auth.login?.('bad')).toBeUndefined();
  });
});

describe('cookieHeader', () => {
  it('keeps the session from scripts and other sites', () => {
    const cookie = cookieHeader('good', { secure: true });
    expect(cookie).toContain('cb_session=good');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Secure');
  });

  it('can only skip Secure when told the connection is not HTTPS', () => {
    expect(cookieHeader('good', { secure: false })).not.toContain('Secure');
  });

  it('clears the session', () => {
    expect(cookieHeader('', { secure: true, clear: true })).toContain('Max-Age=0');
  });
});
