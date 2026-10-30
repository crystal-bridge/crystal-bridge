import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { accessRefusals } from './access.js';
import { backupStore } from './backup.js';
import { pendingMigrations } from './migrations.js';
import { loadNodes } from './nodes.js';
import { createPusher, loadVapidKeys, webPushSender } from './push.js';
import { buildServer } from './server.js';
import { openStore } from './store.js';

const PORT = Number(process.env.AIRSHIP_PORT ?? '7700');
const DB_PATH = process.env.AIRSHIP_DB ?? './airship.db';
const NODES_PATH = process.env.AIRSHIP_NODES;
// Web Push keys live next to the database by default: outside the releases, so deploys keep them.
const VAPID_PATH = process.env.AIRSHIP_VAPID_PATH ?? join(dirname(DB_PATH), 'vapid.json');
// Push services contact this if a sender misbehaves; any mailto: or https: URL will do.
const PUSH_SUBJECT = process.env.AIRSHIP_PUSH_SUBJECT ?? 'mailto:crystal-bridge@example.invalid';
// Deploys write the commit id to RELEASE at the release root; a checkout without one is a dev build.
const RELEASE_FILE = new URL('../../../RELEASE', import.meta.url);
const RELEASE = existsSync(RELEASE_FILE) ? readFileSync(RELEASE_FILE, 'utf8').trim() : 'dev';
const ALLOWED_USERS = (process.env.AIRSHIP_ALLOWED_USERS ?? '')
  .split(',')
  .map((login) => login.trim())
  .filter(Boolean);

// `pnpm dev` passes --dev; AIRSHIP_DEV=1 does the same for other ways of starting a local hub.
const DEV = process.argv.includes('--dev') || process.env.AIRSHIP_DEV === '1';

async function main(): Promise<void> {
  const refusals = accessRefusals({ allowedUsers: ALLOWED_USERS, nodesPath: NODES_PATH, dev: DEV });
  if (refusals.length > 0) {
    for (const reason of refusals) console.error(`[airship] refusing to start: ${reason}`);
    process.exit(1);
  }
  // A schema change goes after a backup, so a bad migration can always be undone.
  const pending = pendingMigrations(DB_PATH);
  if (pending > 0) {
    const dir = process.env.AIRSHIP_BACKUP_DIR ?? './backups';
    const copy = await backupStore(DB_PATH, dir, { keep: Number(process.env.AIRSHIP_BACKUP_KEEP ?? '14') });
    console.log(`[airship] ${pending} schema migration(s) to apply; backed up the database to ${copy} first`);
  }
  const store = openStore(DB_PATH);
  const nodes = NODES_PATH ? loadNodes(NODES_PATH) : undefined;
  if (nodes) {
    console.log(`[airship] node tokens from ${NODES_PATH}: ${nodes.ids().join(', ') || '(none yet)'}`);
  } else {
    console.warn('[airship] development hub without AIRSHIP_NODES: any local process can connect as any node.');
  }
  if (ALLOWED_USERS.length > 0) {
    console.log(`[airship] client side limited to tailnet users: ${ALLOWED_USERS.join(', ')}`);
  } else {
    console.warn('[airship] development hub without AIRSHIP_ALLOWED_USERS: the web app and API are open.');
  }
  const vapid = loadVapidKeys(VAPID_PATH);
  const pusher = createPusher({
    store,
    send: webPushSender(vapid, PUSH_SUBJECT),
    onError: (error) => console.warn('[airship] a Web Push was refused', error),
  });
  console.log(`[airship] Web Push keys from ${VAPID_PATH}`);
  const app = await buildServer({
    store,
    logger: true,
    nodes,
    allowedUsers: ALLOWED_USERS.length > 0 ? ALLOWED_USERS : undefined,
    release: RELEASE,
    push: { publicKey: vapid.publicKey, pusher },
  });

  await app.listen({ port: PORT, host: '127.0.0.1' });
  console.log(`[airship] listening on http://127.0.0.1:${PORT} (db: ${DB_PATH})`);

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[airship] received ${signal}, shutting down`);
    await app.close();
    store.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error('[airship] fatal error during startup', error);
  process.exit(1);
});
