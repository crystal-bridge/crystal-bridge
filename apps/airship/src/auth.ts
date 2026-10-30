import type { FastifyRequest } from 'fastify';

/** How the hub knows who a request is from. Everything that needs an identity asks this, never a header directly. */
export interface Authenticator {
  /** The user this request is from, or undefined when it may not come in. */
  identify(request: FastifyRequest): string | undefined;
  /** What a refused request is told. */
  refusal: string;
  /** The app shell loads for anyone, for a login page to show in. */
  publicApp?: boolean;
  /** Checks a token for logging in, and says whose it is; without it, the hub has no login page. */
  login?(token: string): string | undefined;
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

const COOKIE = 'cb_session';
const COOKIE_DAYS = 30;

/** The hub's session cookie, readable by no script and sent to no other site. */
export function cookieHeader(token: string, { secure, clear = false }: { secure: boolean; clear?: boolean }): string {
  const age = clear ? 0 : COOKIE_DAYS * 24 * 60 * 60;
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
}

function sessionCookie(header: string | undefined): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [name, value] = part.trim().split('=');
    if (name === COOKIE) return value;
  }
  return undefined;
}

/**
 * The hub's own login: long-lived access tokens, as a bearer header or traded for a session cookie. It reads no identity
 * header, so any proxy can sit in front of it. The app shell loads without a login, to show the login page; it holds no
 * data, and `/api` and `/client` stay closed.
 */
export function accessTokens(tokens: { verify(token: string | undefined): string | undefined }): Authenticator {
  return {
    refusal: 'log in first',
    publicApp: true,
    identify(request) {
      const header = request.headers.authorization;
      const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
      return tokens.verify(bearer ?? sessionCookie(request.headers.cookie));
    },
    login: (token) => tokens.verify(token),
  };
}
