/**
 * The hub is a remote control for agents that can run commands on every Kingdom, so it never starts open by accident.
 * Without an allow list the web app and API answer anyone who can reach them; without node tokens any local process
 * can connect as any node. Either is refused unless the operator says this is a development hub.
 */
export interface AccessConfig {
  /** AIRSHIP_AUTH: how the hub knows who a request is from. */
  auth?: string | undefined;
  allowedUsers: readonly string[];
  nodesPath: string | undefined;
  /** A local development hub (`pnpm dev`, or `AIRSHIP_DEV=1`), open on purpose. */
  dev?: boolean;
}

const DEV_HINT = 'For a local development hub only, pnpm dev (or AIRSHIP_DEV=1) starts it open.';

const AUTH_MODES = ['tailscale-serve'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

/**
 * The login method in force: the named one, or for a hub set up before AIRSHIP_AUTH existed, the only one there was. A
 * hub with an allow list and no AIRSHIP_AUTH keeps working through a deploy. Undefined when there is none.
 */
export function authMode({ auth, allowedUsers }: Pick<AccessConfig, 'auth' | 'allowedUsers'>): AuthMode | undefined {
  if (auth !== undefined) return AUTH_MODES.find((mode) => mode === auth);
  return allowedUsers.length > 0 ? 'tailscale-serve' : undefined;
}

/** Why the hub must not start as configured; empty when it may. */
export function accessRefusals({ auth, allowedUsers, nodesPath, dev }: AccessConfig): string[] {
  // Even on a development hub: a typo here must not quietly mean something else.
  if (auth !== undefined && !authMode({ auth, allowedUsers })) {
    return [`AIRSHIP_AUTH is "${auth}", which isn't a login method. Use one of: ${AUTH_MODES.join(', ')}.`];
  }
  if (dev) return [];
  const refusals: string[] = [];
  if (allowedUsers.length === 0) {
    refusals.push(
      'AIRSHIP_ALLOWED_USERS is not set, so the web app and API would be open to anyone who can reach this hub. ' +
        `Set it to the logins allowed in (comma-separated). ${DEV_HINT}`,
    );
  }
  if (!nodesPath) {
    refusals.push(
      'AIRSHIP_NODES is not set, so any process that reaches the hub could connect as any Kingdom. ' +
        `Point it at the node token file (scripts/airship-node-add.sh <hub-host> <node-id> adds a Kingdom's token). ${DEV_HINT}`,
    );
  }
  return refusals;
}
