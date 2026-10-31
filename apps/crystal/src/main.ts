import { gitChanges } from './changes.js';
import { compactWindow } from './compact.js';
import { Engine, PermissionMode } from '@crystal-bridge/protocol';
import { HookBus, InteractiveSession } from './interactive.js';
import { createPermissionServer } from './permissions.js';
import { startNode, type CrystalNode } from './node.js';
import { mergeEnv, readLoginEnv } from './login-env.js';
import { listProjects } from './projects.js';
import { createWorktree, removeWorktree } from './worktree.js';
import { ClaudeSession } from './session.js';
import { findTranscript, listTranscripts, transcriptEvents } from './transcripts.js';
import { resolveClaudeBin } from './claude-bin.js';
import { cachedCliVersion, execCliUpdate, execCliVersion } from './cli-version.js';
import { runJoin, runLeave, type JoinDeps } from './join.js';
import { releaseId } from './release.js';
import { execFile } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { realpathSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The package version, written in by the build (scripts/build.ts); undefined when running from source. */
declare const __KINGDOM_VERSION__: string | undefined;
const VERSION = typeof __KINGDOM_VERSION__ === 'string' ? __KINGDOM_VERSION__ : undefined;

const HUB_URL = process.env.CRYSTAL_HUB ?? 'ws://127.0.0.1:7700/node';
// Never default this to the machine's hostname: node ids show in the UI and logs, which must not name machines.
const NODE_ID = process.env.CRYSTAL_NODE ?? 'local';
const RELEASE = releaseId(VERSION, realpathSync(fileURLToPath(new URL('../../..', import.meta.url))));
// Claude in Chrome for every session, on a node whose user has Chrome and the extension signed in.
const CHROME = process.env.CRYSTAL_CHROME === '1';
const MCP_PORT = Number(process.env.CRYSTAL_MCP_PORT ?? '7701');
// Engines beyond `stream` this node offers, e.g. CRYSTAL_ENGINES=stream,interactive (see interactive.ts).
const ENGINES = (process.env.CRYSTAL_ENGINES ?? '')
  .split(',')
  .map((name) => Engine.safeParse(name.trim()))
  .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
const TOKEN = process.env.CRYSTAL_TOKEN || undefined;
// Unset or unknown: manual. Deploys set auto, the preferred mode.
const DEFAULT_MODE = PermissionMode.catch('manual').parse(process.env.CRYSTAL_DEFAULT_MODE ?? 'manual');
// The CLI's own session transcripts (never its credential files): CLAUDE_CONFIG_DIR, else ~/.claude.
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const PROJECTS_DIR = join(CONFIG_DIR, 'projects');
// Where the New session picker looks for git repos: CRYSTAL_PROJECT_ROOTS (the system's PATH separator), else ~/code.
const PROJECT_ROOTS = (process.env.CRYSTAL_PROJECT_ROOTS ?? join(homedir(), 'code')).split(delimiter).filter(Boolean);

const CLAUDE_BIN = resolveClaudeBin(process.env);

async function main(): Promise<void> {
  // What a terminal session would see, so tools from shell startup files (cargo, pyenv, ...) are on PATH.
  const shell = process.env.CRYSTAL_LOGIN_SHELL ?? process.env.SHELL ?? '/bin/bash';
  const sessionEnv = mergeEnv(process.env, await readLoginEnv(shell));
  console.log(`[crystal] sessions get the ${shell} login environment (${Object.keys(sessionEnv).length} variables)`);

  // `node` is read inside `onRequest` only once a tool call asks for a decision, which is
  // always after `startNode` below has assigned it.
  let node: CrystalNode;
  const hooks = new HookBus();

  const permissionServer = await createPermissionServer({
    port: MCP_PORT,
    host: '127.0.0.1',
    onRequest: (request) => node.handlePermissionRequest(request),
    status: () => node.status(),
    onHook: (session, event, body) => hooks.dispatch(session, event, body),
  });

  node = startNode({
    ...(RELEASE ? { release: RELEASE } : {}),
    hubUrl: HUB_URL,
    node: NODE_ID,
    token: TOKEN,
    worktrees: createWorktree,
    removeWorktree,
    projects: async () =>
      listProjects(
        PROJECT_ROOTS,
        (await listTranscripts(PROJECTS_DIR, { limit: Infinity })).map(({ cwd, updatedAt }) => ({ cwd, updatedAt })),
      ),
    transcripts: {
      list: () => listTranscripts(PROJECTS_DIR),
      async load(id) {
        const file = await findTranscript(PROJECTS_DIR, id);
        if (!file) return undefined;
        const summary = (await listTranscripts(PROJECTS_DIR, { limit: Infinity })).find((t) => t.id === id);
        return summary ? { summary, events: await transcriptEvents(file) } : undefined;
      },
    },
    cliVersion: cachedCliVersion({ exec: execCliVersion(CLAUDE_BIN, sessionEnv) }),
    updateCli: execCliUpdate(CLAUDE_BIN, sessionEnv),
    defaultMode: DEFAULT_MODE,
    ...(ENGINES.length > 0 ? { engines: [...new Set<Engine>(['stream', ...ENGINES])] } : {}),
    sessionFactory: ({ engine, ...opts }) => {
      const changes = gitChanges(opts.cwd);
      const compactWindowFor = (model: string | undefined) =>
        compactWindow({ env: sessionEnv, cwd: opts.cwd, configDir: CONFIG_DIR, model });
      return engine === 'interactive'
        ? new InteractiveSession({
            ...opts,
            claudeBin: CLAUDE_BIN,
            env: sessionEnv,
            chrome: CHROME,
            changes,
            compactWindow: compactWindowFor,
            hooks,
            hookUrl: permissionServer.hookUrl(opts.session),
          })
        : new ClaudeSession({
            ...opts,
            claudeBin: CLAUDE_BIN,
            env: sessionEnv,
            chrome: CHROME,
            changes,
            compactWindow: compactWindowFor,
          });
    },
    permissionServer,
  });

  console.log(
    `[crystal] node "${NODE_ID}" dialing ${HUB_URL}, permission server on http://127.0.0.1:${permissionServer.port}`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[crystal] received ${signal}, shutting down`);
    // Wait for the claude processes to stop: with KillMode=process nothing else would end them.
    await node.close();
    await permissionServer.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/** What `join` and `leave` touch, for real. The sudo for lingering may ask for a password, so it gets the terminal. */
function joinDeps(): JoinDeps {
  return {
    home: homedir(),
    platform: process.platform,
    user: userInfo().username,
    uid: process.getuid?.() ?? 0,
    version: VERSION ?? 'dev',
    mainPath: realpathSync(fileURLToPath(import.meta.url)),
    nodeBin: process.execPath,
    path: process.env.PATH ?? '',
    claudeBin: CLAUDE_BIN,
    shell: process.env.SHELL ?? '/bin/bash',
    fetch,
    exec: (file, args) =>
      new Promise((resolve, reject) => {
        const child = execFile(file, args, { timeout: 120_000 }, (error, stdout) =>
          error ? reject(error) : resolve(stdout),
        );
        if (file === 'sudo') child.stderr?.pipe(process.stderr);
      }),
    log: (line) => console.log(line),
  };
}

function fail(error: unknown): never {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const [command, hub, code] = process.argv.slice(2);
if (process.argv.includes('--version')) {
  console.log(VERSION ?? RELEASE ?? 'dev');
  process.exit(0);
} else if (command === 'join') {
  if (!hub || !code) fail('usage: crystal-bridge-kingdom join <hub-url> <code>');
  runJoin(hub, code, joinDeps()).catch(fail);
} else if (command === 'leave') {
  runLeave(joinDeps()).catch(fail);
} else if (command) {
  fail('usage: crystal-bridge-kingdom [join <hub-url> <code> | leave | --version]');
} else {
  main().catch((error: unknown) => {
    console.error('[crystal] fatal error during startup', error);
    process.exit(1);
  });
}
