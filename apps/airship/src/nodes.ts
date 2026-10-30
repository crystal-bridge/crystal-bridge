import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

/** Which node a connection's bearer token belongs to. */
export interface NodeRegistry {
  /** The node id the token was issued to, or undefined for an unknown, empty or missing token. */
  verify(token: string | undefined): string | undefined;
  ids(): string[];
}

/** Node ids appear in URLs, logs and the UI, so keep them to a plain slug. */
const NODE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/i;

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

/**
 * Issues a new token for `node` and stores only its SHA-256 in the nodes file, replacing any earlier
 * token for that node. The token itself is returned once and never written anywhere.
 */
export function addNode(path: string, node: string): string {
  if (!NODE_ID.test(node)) throw new Error(`invalid node id: ${JSON.stringify(node)} (letters, digits and dashes)`);
  const file = read(path);
  const token = randomBytes(32).toString('base64url');
  file.nodes[node] = { sha256: sha256(token).toString('hex'), addedAt: Date.now() };
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600); // writeFileSync's mode only applies when it creates the file
  return token;
}

/** Loads the nodes file once; restart the hub after adding or rotating a node. */
export function loadNodes(path: string): NodeRegistry {
  const entries = Object.entries(read(path).nodes).map(([id, entry]) => ({
    id,
    hash: Buffer.from(entry.sha256, 'hex'),
  }));
  return {
    verify(token) {
      if (!token) return undefined;
      const hash = sha256(token);
      return entries.find((entry) => timingSafeEqual(entry.hash, hash))?.id;
    },
    ids() {
      return entries.map((entry) => entry.id).sort();
    },
  };
}
