import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const LABEL = 'dev.crystal-bridge.crystal';
const SERVICE = 'crystal.service';
/** Not the source default, so `pnpm dev` still runs on a machine that is also a Kingdom. */
const MCP_PORT = '7711';
const ENTRY = 'node_modules/@crystal-bridge/kingdom/dist/main.js';

export interface ServicePaths {
  nodeBin: string;
  mainJs: string;
  envFile: string;
  logFile: string;
  /** Set here, not in the env file: --env-file leaves alone a variable the service manager already set. */
  path: string;
}

/** A systemd user unit. The token stays in the env file, which only its owner can read. */
export function systemdUnit({ nodeBin, mainJs, envFile, path }: ServicePaths): string {
  return `# Written by \`crystal-bridge-kingdom join\`; \`crystal-bridge-kingdom leave\` removes it.
[Unit]
Description=Crystal Bridge Kingdom agent
After=network-online.target

[Service]
Type=simple
Environment=PATH=${path}
ExecStart=${nodeBin} --env-file=${envFile} ${mainJs}
Restart=on-failure
RestartSec=5
# Stop only the agent: it closes its sessions on SIGTERM, and work a Quest left running must survive a restart.
KillMode=process
TimeoutStopSec=15

[Install]
WantedBy=default.target
`;
}

/** A launchd user agent, under the same rules as the systemd unit. */
export function launchdPlist({ nodeBin, mainJs, envFile, logFile, path }: ServicePaths): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>--env-file=${envFile}</string>
    <string>${mainJs}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${path}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ExitTimeOut</key>
  <integer>15</integer>
  <key>StandardOutPath</key>
  <string>${logFile}</string>
  <key>StandardErrorPath</key>
  <string>${logFile}</string>
</dict>
</plist>
`;
}

/** Where the service definition lives. */
export function servicePath(home: string, platform: NodeJS.Platform): string {
  return platform === 'darwin'
    ? join(home, 'Library/LaunchAgents', `${LABEL}.plist`)
    : join(home, '.config/systemd/user', SERVICE);
}

/** The node socket of a hub given by its web address. */
export function hubSocketUrl(hub: string): string {
  return `${hub.replace(/\/+$/, '').replace(/^http/, 'ws')}/node`;
}

/** The web address of a hub given by its node socket. */
export function hubHttpUrl(socket: string): string {
  return socket.replace(/\/node$/, '').replace(/^ws/, 'http');
}

/** The folder holding the `node_modules` this package runs from; undefined when running from source. */
export function installRootOf(mainPath: string): string | undefined {
  const marker = '/node_modules/@crystal-bridge/kingdom/';
  const at = mainPath.lastIndexOf(marker);
  return at === -1 ? undefined : mainPath.slice(0, at);
}

export interface JoinDeps {
  home: string;
  platform: NodeJS.Platform;
  user: string;
  uid: number;
  version: string;
  /** The real path of this running file. */
  mainPath: string;
  nodeBin: string;
  path: string;
  claudeBin: string;
  shell: string;
  fetch: (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;
  exec: (file: string, args: string[]) => Promise<string>;
  log: (line: string) => void;
}

interface Layout {
  base: string;
  envFile: string;
  logFile: string;
  service: string;
}

function layout({ home, platform }: Pick<JoinDeps, 'home' | 'platform'>): Layout {
  return {
    base: join(home, '.local/share/crystal-bridge'),
    envFile: join(home, '.config/crystal-bridge/crystal.env'),
    logFile:
      platform === 'darwin'
        ? join(home, 'Library/Logs/crystal-bridge/crystal.log')
        : join(home, '.local/share/crystal-bridge/crystal.log'),
    service: servicePath(home, platform),
  };
}

/** The checks that can fail before anything is written or the one-time code is spent. */
async function checkMachine(deps: JoinDeps, where: Layout): Promise<string> {
  if (deps.platform !== 'linux' && deps.platform !== 'darwin') {
    throw new Error('This installer runs on Linux and macOS for now.');
  }
  if (existsSync(where.envFile) && /^CRYSTAL_TOKEN=./m.test(readFileSync(where.envFile, 'utf8'))) {
    throw new Error(`This machine is already a Kingdom (${where.envFile}). Run "crystal-bridge-kingdom leave" first.`);
  }
  const root = installRootOf(deps.mainPath);
  if (!root) throw new Error('join has to run from the installed package, not from source.');
  await deps.exec(deps.claudeBin, ['--version']).catch(() => {
    throw new Error('Claude Code is not installed here, or not on your PATH. Install it, then run this again.');
  });
  // Only the CLI's own documented status, and only this one field of it.
  const signedIn = await deps
    .exec(deps.claudeBin, ['auth', 'status'])
    .then((output) => (JSON.parse(output) as { loggedIn?: unknown }).loggedIn === true)
    .catch(() => false);
  if (!signedIn) {
    throw new Error(
      'Claude Code is not signed in on this machine. Run "claude auth login", which works without a browser here by ' +
        'printing a link to open on any device, then run this again.',
    );
  }
  return root;
}

/** Copies the package out of npx's temporary folder, so the service outlives it. */
function installCopy(root: string, deps: JoinDeps, base: string): string {
  const release = join(base, 'releases', deps.version);
  rmSync(release, { recursive: true, force: true });
  mkdirSync(release, { recursive: true });
  cpSync(join(root, 'node_modules'), join(release, 'node_modules'), { recursive: true, verbatimSymlinks: true });
  const link = join(base, 'current');
  const next = `${link}.next`;
  rmSync(next, { force: true });
  symlinkSync(release, next);
  renameSync(next, link);
  return join(link, ENTRY);
}

async function redeemCode(hub: string, code: string, deps: JoinDeps): Promise<{ node: string; token: string }> {
  const response = await deps.fetch(`${hub}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const body = (await response.json()) as { node?: string; token?: string; error?: string };
  if (!response.ok || !body.node || !body.token) {
    throw new Error(`The hub refused this join: ${body.error ?? `status ${response.status}`}`);
  }
  return { node: body.node, token: body.token };
}

async function enableLinger(deps: JoinDeps): Promise<void> {
  const linger = await deps.exec('loginctl', ['show-user', deps.user, '-p', 'Linger', '--value']).catch(() => '');
  if (linger.trim() === 'yes') return;
  deps.log('Turning on lingering, so the Kingdom keeps running after you log out. This needs sudo, once.');
  await deps.exec('sudo', ['loginctl', 'enable-linger', deps.user]).catch(() => {
    deps.log(`Could not. The Kingdom stops when you log out until you run: sudo loginctl enable-linger ${deps.user}`);
  });
}

async function startService(deps: JoinDeps, where: Layout): Promise<void> {
  if (deps.platform === 'darwin') {
    const domain = `gui/${deps.uid}`;
    await deps.exec('launchctl', ['bootout', `${domain}/${LABEL}`]).catch(() => undefined);
    await deps.exec('launchctl', ['bootstrap', domain, where.service]);
    return;
  }
  await enableLinger(deps);
  await deps.exec('systemctl', ['--user', 'daemon-reload']);
  await deps.exec('systemctl', ['--user', 'enable', '--now', SERVICE]);
}

async function stopService(deps: JoinDeps, where: Layout): Promise<void> {
  if (deps.platform === 'darwin') {
    await deps.exec('launchctl', ['bootout', `gui/${deps.uid}/${LABEL}`]).catch(() => undefined);
  } else {
    await deps.exec('systemctl', ['--user', 'disable', '--now', SERVICE]).catch(() => undefined);
  }
  rmSync(where.service, { force: true });
  if (deps.platform !== 'darwin') await deps.exec('systemctl', ['--user', 'daemon-reload']).catch(() => undefined);
}

/** Turns this machine into a Kingdom of the hub. Nothing is spent until everything that can be checked has passed. */
export async function runJoin(hubUrl: string, code: string, deps: JoinDeps): Promise<void> {
  const where = layout(deps);
  const root = await checkMachine(deps, where);
  const hub = hubUrl.replace(/\/+$/, '');
  const mainJs = installCopy(root, deps, where.base);
  const { node, token } = await redeemCode(hub, code, deps);

  const path = deps.path
    .split(':')
    .filter((entry) => entry && !entry.includes('/_npx/'))
    .join(':');
  mkdirSync(dirname(where.envFile), { recursive: true });
  writeFileSync(
    where.envFile,
    [
      `CRYSTAL_HUB=${hubSocketUrl(hub)}`,
      `CRYSTAL_NODE=${node}`,
      `CRYSTAL_TOKEN=${token}`,
      'CRYSTAL_DEFAULT_MODE=auto',
      `CRYSTAL_MCP_PORT=${MCP_PORT}`,
      `CRYSTAL_LOGIN_SHELL=${deps.shell}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  chmodSync(where.envFile, 0o600);

  mkdirSync(dirname(where.service), { recursive: true });
  mkdirSync(dirname(where.logFile), { recursive: true });
  const paths = { nodeBin: deps.nodeBin, mainJs, envFile: where.envFile, logFile: where.logFile, path };
  writeFileSync(where.service, deps.platform === 'darwin' ? launchdPlist(paths) : systemdUnit(paths));
  await startService(deps, where);

  deps.log(`Kingdom "${node}" joined ${hub}. It runs as a service and dials out to the hub.`);
  deps.log('To remove it: crystal-bridge-kingdom leave');
}

function envValue(env: string, key: string): string | undefined {
  return new RegExp(`^${key}=(.*)$`, 'm').exec(env)?.[1];
}

/** Gives up this Kingdom's token and removes everything join installed. */
export async function runLeave(deps: JoinDeps): Promise<void> {
  const where = layout(deps);
  const env = existsSync(where.envFile) ? readFileSync(where.envFile, 'utf8') : '';
  const socket = envValue(env, 'CRYSTAL_HUB');
  const token = envValue(env, 'CRYSTAL_TOKEN');
  if (!socket || !token) throw new Error('This machine is not a Kingdom.');

  const left = await deps
    .fetch(`${hubHttpUrl(socket)}/api/leave`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
    .then((response) => response.ok || response.status === 401)
    .catch(() => false);

  await stopService(deps, where);
  rmSync(where.envFile, { force: true });
  rmSync(where.base, { recursive: true, force: true });
  deps.log(
    left ? 'This Kingdom has left its hub.' : 'Removed here, but the hub did not answer: remove it from the app.',
  );
}
