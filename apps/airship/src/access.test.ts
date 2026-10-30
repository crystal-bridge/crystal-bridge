import { describe, expect, it } from 'vitest';
import { accessRefusals } from './access.js';

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

  it('starts open only when told it is a development hub', () => {
    expect(accessRefusals({ allowedUsers: [], nodesPath: undefined, dev: true })).toEqual([]);
  });
});
