import { describe, expect, it } from 'vitest';
import { accessRefusals, authMode } from './access.js';

describe('accessRefusals', () => {
  it('lets a hub start with an allow list and node tokens', () => {
    expect(accessRefusals({ allowedUsers: ['me@example.com'], nodesPath: '/var/lib/airship/nodes.json' })).toEqual([]);
  });

  it('refuses to start open: no allow list, or no node tokens', () => {
    const both = accessRefusals({ allowedUsers: [], nodesPath: undefined });
    expect(both).toHaveLength(2);
    expect(both.join('\n')).toMatch(/AIRSHIP_ALLOWED_USERS/);
    expect(both.join('\n')).toMatch(/AIRSHIP_NODES/);
    expect(both.join('\n')).toMatch(/AIRSHIP_DEV=1/);
    expect(accessRefusals({ allowedUsers: [], nodesPath: '/n.json' })).toHaveLength(1);
  });

  it('takes tailscale-serve by name, and still needs its allow list', () => {
    expect(accessRefusals({ auth: 'tailscale-serve', allowedUsers: ['me@example.com'], nodesPath: '/n.json' })).toEqual(
      [],
    );
    expect(accessRefusals({ auth: 'tailscale-serve', allowedUsers: [], nodesPath: '/n.json' }).join()).toMatch(
      /AIRSHIP_ALLOWED_USERS/,
    );
  });

  it('takes token login with no allow list', () => {
    expect(accessRefusals({ auth: 'token', allowedUsers: [], nodesPath: '/n.json' })).toEqual([]);
    expect(authMode({ auth: 'token', allowedUsers: ['ignored@example.com'] })).toBe('token');
  });

  it('still needs node tokens with token login', () => {
    expect(accessRefusals({ auth: 'token', allowedUsers: [], nodesPath: undefined }).join()).toMatch(/AIRSHIP_NODES/);
  });

  it('keeps a hub that predates AIRSHIP_AUTH running as it did', () => {
    expect(authMode({ allowedUsers: ['me@example.com'] })).toBe('tailscale-serve');
  });

  it('refuses a login method it does not know, even on a development hub', () => {
    const refusals = accessRefusals({
      auth: 'magic',
      allowedUsers: ['me@example.com'],
      nodesPath: '/n.json',
      dev: true,
    });
    expect(refusals.join()).toMatch(/AIRSHIP_AUTH/);
  });

  it('starts open only when told it is a development hub', () => {
    expect(accessRefusals({ allowedUsers: [], nodesPath: undefined, dev: true })).toEqual([]);
  });
});
