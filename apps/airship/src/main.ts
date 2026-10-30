import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessRefusals, authMode } from './access.js';
import { accessTokens, tailscaleServe } from './auth.js';
import { backupStore } from './backup.js';
import { latestCliChecker } from './cli-release.js';
import { createFirstRun } from './first-run.js';
import { pendingMigrations } from './migrations.js';
import { loadNodes } from './nodes.js';
import { hubPaths } from './paths.js';
import { createPusher, loadVapidKeys, webPushSender } from './push.js';
import { buildServer } from './server.js';
import { openStore } from './store.js';
import { runTokens } from './tokens.js';

const PORT = Number(process.env.AIRSHIP_PORT ?? '7700');
const HOST = process.env.AIRSHIP_HOST ?? '127.0.0.1';
const {
  db: DB_PATH,
  nodes: NODES_PATH,
  tokens: TOKENS_PATH,
  vapid: VAPID_PATH,
  backups: BACKUP_DIR,
} = hubPaths(process.env);
// Push services contact this if a sender misbehaves; any mailto: or https: URL will do.
const PUSH_SUBJECT = process.env.AIRSHIP_PUSH_SUBJECT ?? 'mailto:crystal-bridge@example.invalid';
/** The package version, written in by the build (scripts/build.ts); undefined when running from source. */
declare const __AIRSHIP_VERSION__: string | undefined;
const VERSION = typeof __AIRSHIP_VERSION__ === 'string' ? __AIRSHIP_VERSION__ : undefined;
// Deploys write the commit id to RELEASE at the release root; a checkout without one is a dev build.
const RELEASE_FILE = new URL('../../../RELEASE', import.meta.url);
const RELEASE = VERSION ?? (existsSync(RELEASE_FILE) ? readFileSync(RELEASE_FILE, 'utf8').trim() : 'dev');
const AUTH = process.env.AIRSHIP_AUTH || undefined;
const ALLOWED_USERS = (process.env.AIRSHIP_ALLOWED_USERS ?? '')
  .split(',')
  .map((login) => login.trim())
  .filter(Boolean);

// `pnpm dev` passes --dev; AIRSHIP_DEV=1 does the same for other ways of starting a local hub.
const DEV = process.argv.includes('--dev') || process.env.AIRSHIP_DEV === '1';

async function main(): Promise<void> {
  const refusals = accessRefusals({
    auth: AUTH,
    allowedUsers: ALLOWED_USERS,
    nodesPath: NODES_PATH,
    host: HOST,
    dev: DEV,
  });
  if (refusals.length > 0) {
    for (const reason of refusals) console.error(`[airship] refusing to start: ${reason}`);
    process.exit(1);
  }
  // A schema change goes after a backup, so a bad migration can always be undone.
  const pending = pendingMigrations(DB_PATH);
  if (pending > 0) {
    const copy = await backupStore(DB_PATH, BACKUP_DIR, { keep: Number(process.env.AIRSHIP_BACKUP_KEEP ?? '14') });
    console.log(`[airship] ${pending} schema migration(s) to apply; backed up the database to ${copy} first`);
  }
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const store = openStore(DB_PATH);
  const nodes = NODES_PATH ? loadNodes(NODES_PATH) : undefined;
  if (nodes) {
    console.log(`[airship] node tokens from ${NODES_PATH}: ${nodes.ids().join(', ') || '(none yet)'}`);
  } else {
    console.warn('[airship] development hub without AIRSHIP_NODES: any local process can connect as any node.');
  }
  const mode = authMode({ auth: AUTH, allowedUsers: ALLOWED_USERS });
  const tokens = mode === 'token' ? loadNodes(TOKENS_PATH) : undefined;
  const auth = tokens ? accessTokens(tokens) : mode === 'tailscale-serve' ? tailscaleServe(ALLOWED_USERS) : undefined;
  if (tokens) {
    console.log(`[airship] token login, tokens from ${TOKENS_PATH}: ${tokens.ids().join(', ') || '(none yet)'}`);
  } else if (ALLOWED_USERS.length > 0) {
    console.log(`[airship] client side limited to tailnet users: ${ALLOWED_USERS.join(', ')}`);
  } else {
    console.warn('[airship] development hub without AIRSHIP_ALLOWED_USERS: the web app and API are open.');
  }
  const firstRun = tokens && tokens.ids().length === 0 ? createFirstRun(tokens) : undefined;
  if (firstRun) {
    console.warn('[airship] no logins yet. Open the hub in a browser and enter this one-time setup code:');
    console.warn(`[airship]   ${firstRun.code}`);
    console.warn('[airship] Or make a login from a shell, with the `token add <name>` command.');
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
    ...(auth ? { auth } : {}),
    ...(firstRun ? { firstRun } : {}),
    release: RELEASE,
    ...(VERSION ? { webRoot: fileURLToPath(new URL('web', import.meta.url)) } : {}),
    ...(process.env.AIRSHIP_CLI_CHECK === 'off' ? {} : { latestCli: latestCliChecker() }),
    push: { publicKey: vapid.publicKey, pusher },
  });

  await app.listen({ port: PORT, host: HOST });
  console.log(`[airship] listening on http://${HOST}:${PORT} (db: ${DB_PATH})`);

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

const [command, ...rest] = process.argv.slice(2);
if (command === '--version') {
  console.log(RELEASE);
} else if (command === 'token') {
  mkdirSync(dirname(TOKENS_PATH), { recursive: true });
  runTokens(TOKENS_PATH, rest);
} else {
  main().catch((error: unknown) => {
    console.error('[airship] fatal error during startup', error);
    process.exit(1);
  });
}
