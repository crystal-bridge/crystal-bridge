import type { FastifyRequest } from 'fastify';

/** How the hub knows who a request is from. Everything that needs an identity asks this, never a header directly. */
export interface Authenticator {
  /** The user this request is from, or undefined when it may not come in. */
  identify(request: FastifyRequest): string | undefined;
  /** What a refused request is told. */
  refusal: string;
}

/**
 * Identity from `tailscale serve`, which sets `Tailscale-User-Login` on every request it proxies. The hub can't tell
 * that proxy from any other local one, so this is only safe with nothing else in front (docs/SECURITY-MODEL.md).
 */
export function tailscaleServe(allowedUsers: readonly string[]): Authenticator {
  const allowed = new Set(allowedUsers.map((login) => login.toLowerCase()));
  return {
    refusal: 'not an allowed tailnet user',
    identify(request) {
      const login = request.headers['tailscale-user-login'];
      if (typeof login !== 'string') return undefined;
      const lowered = login.toLowerCase();
      return allowed.has(lowered) ? lowered : undefined;
    },
  };
}
