import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

/** Which node a connection's bearer token belongs to. */
export interface NodeRegistry {
  /** The node id the token was issued to, or undefined for an unknown, empty or missing token. */
  verify(token: string | undefined): string | undefined;
  ids(): string[];
  /** Removes the node's token for good; false if it has none. */
  revoke(node: string): boolean;
  /** Issues the node's token, shown once. */
  issue(node: string): string;
}

/** Node ids appear in URLs, logs and the UI, so keep them to a plain slug. */
const NODE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/i;

export function isNodeId(node: string): boolean {
  return NODE_ID.test(node);
}

const NodesFile = z.object({
  nodes: z.record(z.string(), z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), addedAt: z.number().int() })),
});
type NodesFile = z.infer<typeof NodesFile>;

function sha256(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function read(path: string): NodesFile {
  return existsSync(path) ? NodesFile.parse(JSON.parse(readFileSync(path, 'utf8'))) : { nodes: {} };
}

/** Replaces the file in one step, because the hub reads it on every connection and must never see half of it. */
function write(path: string, file: NodesFile): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/**
 * Issues a new token for `node` and stores only its SHA-256 in the nodes file, replacing any earlier
 * token for that node. The token itself is returned once and never written anywhere.
 */
export function addNode(path: string, node: string): string {
  if (!NODE_ID.test(node)) throw new Error(`invalid node id: ${JSON.stringify(node)} (letters, digits and dashes)`);
  const file = read(path);
  const token = randomBytes(32).toString('base64url');
  file.nodes[node] = { sha256: sha256(token).toString('hex'), addedAt: Date.now() };
  write(path, file);
  return token;
}

/** Reads the nodes file on every call, so a token issued or revoked takes effect without restarting the hub. */
export function loadNodes(path: string): NodeRegistry {
  return {
    verify(token) {
      if (!token) return undefined;
      const hash = sha256(token);
      return Object.entries(read(path).nodes).find(([, entry]) =>
        timingSafeEqual(Buffer.from(entry.sha256, 'hex'), hash),
      )?.[0];
    },
    ids() {
      return Object.keys(read(path).nodes).sort();
    },
    issue(node) {
      return addNode(path, node);
    },
    revoke(node) {
      const file = read(path);
      if (!Object.hasOwn(file.nodes, node)) return false;
      delete file.nodes[node];
      write(path, file);
      return true;
    },
  };
}
