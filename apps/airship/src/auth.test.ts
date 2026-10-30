import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { tailscaleServe } from './auth.js';

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
