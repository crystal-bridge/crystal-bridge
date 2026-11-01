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
import { runAdopt, runJoin, runLeave, runRollback, type JoinDeps } from './join.js';
import { verifyRelease } from './provenance.js';
import { activateRelease, heldVersions, releaseId, selfUpdateBase, stageRelease, type ReleaseDeps } from './release.js';
import { createUpdater } from './self-update.js';
import { createSummons, parseSummons, summonCall, summonDescription, targetShell } from './summons.js';
import { execFile } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { realpathSync, writeFileSync } from 'node:fs';
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

/** Exiting with a failure is what makes every service manager, and `crystal.cmd`, start Crystal again. */
const EXIT_RESTART = 75;

/** What installing a release touches, for real. It gets the sessions' environment, which holds no token. */
function releaseDeps(base: string, env: Record<string, string | undefined>): ReleaseDeps {
  return {
    base,
    platform: process.platform,
    nodeBin: process.execPath,
    fetch,
    verify: (tarball, version) =>
      verifyRelease(tarball, version, {
        fetch,
        trustedRoot: async () => (await import('@sigstore/tuf')).getTrustedRoot({ cachePath: join(base, 'tuf') }),
      }),
    exec: (file, args, cwd) =>
      new Promise((resolve, reject) => {
        execFile(file, args, { cwd, env, timeout: 300_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) =>
          error ? reject(new Error(`${error.message}\n${stderr}`.trim())) : resolve(stdout),
        );
      }),
  };
}

async function main(): Promise<void> {
  // What a terminal session would see, so tools from shell startup files (cargo, pyenv, ...) are on PATH.
  const shell = process.env.CRYSTAL_LOGIN_SHELL ?? process.env.SHELL ?? '/bin/bash';
  const sessionEnv = mergeEnv(process.env, await readLoginEnv(shell));
  console.log(`[crystal] sessions get the ${shell} login environment (${Object.keys(sessionEnv).length} variables)`);

  // `node` is read inside `onRequest` only once a tool call asks for a decision, which is
  // always after `startNode` below has assigned it.
  let node: CrystalNode;
  const hooks = new HookBus();

  // Only a copy `join` installed: anything else is updated by whatever installed it.
  const updateBase =
    VERSION && process.env.CRYSTAL_SELF_UPDATE !== 'off'
      ? selfUpdateBase(realpathSync(fileURLToPath(import.meta.url)), process.platform)
      : undefined;
  const updater =
    VERSION && updateBase
      ? createUpdater({
          current: VERSION,
          held: () => heldVersions(updateBase),
          stage: (version) => stageRelease(version, releaseDeps(updateBase, sessionEnv)),
          activate: (version) => activateRelease(version, { base: updateBase, platform: process.platform }),
          busy: () => node.status().busy.length > 0,
          report: (state) => node.reportSelfUpdate(state),
          restart: () => void shutdown('self-update', EXIT_RESTART),
          log: (line) => console.log(line),
        })
      : undefined;

  const targets = parseSummons(process.env.CRYSTAL_SUMMONS, process.platform);
  const summons = createSummons({
    targets,
    // Beside the Kingdom's own job folders, and outside any release, so an update keeps it.
    statePath: join(homedir(), '.crystal-bridge', 'casts.json'),
    spawnOn: targetShell(sessionEnv, homedir()),
    report: (cast) => node.reportCast(cast),
  });

  const permissionServer = await createPermissionServer({
    port: MCP_PORT,
    host: '127.0.0.1',
    onRequest: (request) => node.handlePermissionRequest(request),
    summon: {
      description: () => summonDescription(targets),
      call: async (session, args) => {
        if (!node.holds(session)) throw new Error('This session is not running on this node.');
        return summonCall(summons, session, args);
      },
    },
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
    ...(updater ? { onKingdomVersion: updater.target } : {}),
    summons,
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

  summons.resume();

  console.log(
    `[crystal] node "${NODE_ID}" dialing ${HUB_URL}, permission server on http://127.0.0.1:${permissionServer.port}`,
  );

  // On Windows `leave` has no service manager that can stop this process, so it needs the id.
  if (process.env.CRYSTAL_PID_FILE) writeFileSync(process.env.CRYSTAL_PID_FILE, String(process.pid));

  let shuttingDown = false;
  const shutdown = async (reason: string, code = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[crystal] ${reason}, shutting down`);
    updater?.close();
    summons.close();
    // Wait for the claude processes to stop: with KillMode=process nothing else would end them.
    await node.close();
    await permissionServer.close();
    process.exit(code);
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
    kill: (pid) => process.kill(pid),
    log: (line) => console.log(line),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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
} else if (command === 'rollback') {
  runRollback(joinDeps()).catch(fail);
} else if (command === 'adopt') {
  runAdopt(joinDeps()).catch(fail);
} else if (command) {
  fail('usage: crystal-bridge-kingdom [join <hub-url> <code> | leave | rollback | adopt | --version]');
} else {
  main().catch((error: unknown) => {
    console.error('[crystal] fatal error during startup', error);
    process.exit(1);
  });
}
