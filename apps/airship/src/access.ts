/**
 * The hub is a remote control for agents that can run commands on every Kingdom, so it never starts open by accident.
 * Without an allow list the web app and API answer anyone who can reach them; without node tokens any local process
 * can connect as any node. Either is refused unless the operator says this is a development hub.
 */
export interface AccessConfig {
  allowedUsers: readonly string[];
  nodesPath: string | undefined;
  /** A local development hub (`pnpm dev`, or `AIRSHIP_DEV=1`), open on purpose. */
  dev?: boolean;
}

const DEV_HINT = 'For a local development hub only, pnpm dev (or AIRSHIP_DEV=1) starts it open.';

/** Why the hub must not start as configured; empty when it may. */
export function accessRefusals({ allowedUsers, nodesPath, dev }: AccessConfig): string[] {
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
