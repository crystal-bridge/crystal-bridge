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
import { LEAVE_COMMAND, LEAVE_COMMAND_WINDOWS } from '@crystal-bridge/protocol';
import { ENTRY, installRootOf, rollbackRelease } from './release.js';

const LABEL = 'dev.crystal-bridge.crystal';
const SERVICE = 'crystal.service';
const TASK = 'CrystalBridgeKingdom';
/** Not the source default, so `pnpm dev` still runs on a machine that is also a Kingdom. */
const MCP_PORT = '7711';
/** The port of an agent that doesn't name one, which is every Linux Kingdom the deploy scripts made. */
const DEFAULT_MCP_PORT = '7701';
/** How long `adopt` waits for Quests, as a deploy scheduled for an idle moment does. */
const ADOPT_WAIT_SECONDS = 3600;
const ADOPT_POLL_SECONDS = 5;

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
  return `# Written by \`crystal-bridge-kingdom join\`; its \`leave\` removes this.
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

const xmlText = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/**
 * What the Windows task runs. It restarts Crystal after a crash, because the headless console hides the exit code from
 * Task Scheduler, and it names its own files by its folder, so nothing here depends on how the user's name is spelled.
 */
export function windowsScript(nodeBin: string): string {
  const entry = ENTRY.replaceAll('/', '\\');
  return [
    '@echo off',
    'rem Written by `crystal-bridge-kingdom join`; its `leave` removes this.',
    'set "CRYSTAL_PID_FILE=%~dp0crystal.pid"',
    ':run',
    // A self-update exits to get here: Windows won't rename a folder while a program runs from it.
    // First what a swap cut off in the middle left behind: without `current` nothing below can run.
    'if not exist "%~dp0current\\" if exist "%~dp0next\\" move "%~dp0next" "%~dp0current" >nul',
    'if not exist "%~dp0current\\" if exist "%~dp0previous\\" move "%~dp0previous" "%~dp0current" >nul',
    'if not exist "%~dp0next\\" goto start',
    // The last release to go back to is deleted only once the new one is in place.
    'if exist "%~dp0previous.old\\" rmdir /s /q "%~dp0previous.old"',
    'if exist "%~dp0previous\\" move "%~dp0previous" "%~dp0previous.old" >nul || goto start',
    'move "%~dp0current" "%~dp0previous" >nul || goto start',
    'move "%~dp0next" "%~dp0current" >nul || move "%~dp0previous" "%~dp0current" >nul',
    'if exist "%~dp0previous.old\\" rmdir /s /q "%~dp0previous.old"',
    ':start',
    `"${nodeBin.replaceAll('%', '%%')}" --env-file="%~dp0crystal.env" "%~dp0current\\${entry}" >> "%~dp0crystal.log" 2>&1`,
    'if %errorlevel% equ 0 exit /b 0',
    'ping -n 6 127.0.0.1 >nul',
    'goto run',
    '',
  ].join('\r\n');
}

/**
 * A Task Scheduler task that starts Crystal at this user's sign-in. It needs no administrator, which is also why it
 * runs only while they're signed in. A headless console keeps a window from opening on their desktop; it rewrites the
 * command line it passes on, so that line stays this plain and the work lives in the script.
 */
export function windowsTask({ script, user }: { script: string; user: string }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlText(user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlText(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions>
    <Exec>
      <Command>conhost.exe</Command>
      <Arguments>--headless "${xmlText(script)}"</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/** Where the service definition lives. */
export function servicePath(home: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') return join(windowsHome(home), 'task.xml');
  return platform === 'darwin'
    ? join(home, 'Library/LaunchAgents', `${LABEL}.plist`)
    : join(home, '.config/systemd/user', SERVICE);
}

function windowsHome(home: string): string {
  return join(home, 'AppData/Local/crystal-bridge');
}

/** The node socket of a hub given by its web address. */
export function hubSocketUrl(hub: string): string {
  return `${hub.replace(/\/+$/, '').replace(/^http/, 'ws')}/node`;
}

/** The web address of a hub given by its node socket. */
export function hubHttpUrl(socket: string): string {
  return socket.replace(/\/node$/, '').replace(/^ws/, 'http');
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
  kill: (pid: number) => void;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
}

interface Layout {
  base: string;
  envFile: string;
  logFile: string;
  service: string;
}

function layout({ home, platform }: Pick<JoinDeps, 'home' | 'platform'>): Layout {
  if (platform === 'win32') {
    const base = windowsHome(home);
    return {
      base,
      envFile: join(base, 'crystal.env'),
      logFile: join(base, 'crystal.log'),
      service: servicePath(home, platform),
    };
  }
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

function leaveCommand({ platform }: Pick<JoinDeps, 'platform'>): string {
  return platform === 'win32' ? LEAVE_COMMAND_WINDOWS : LEAVE_COMMAND;
}

/** The checks that can fail before anything is written or the one-time code is spent. */
async function checkMachine(deps: JoinDeps, where: Layout): Promise<string> {
  if (deps.platform !== 'linux' && deps.platform !== 'darwin' && deps.platform !== 'win32') {
    throw new Error('This installer runs on Linux, macOS and Windows.');
  }
  if (existsSync(where.envFile) && /^CRYSTAL_TOKEN=./m.test(readFileSync(where.envFile, 'utf8'))) {
    throw new Error(
      `This machine is already a Kingdom (${where.envFile}). To start over, first run: ${leaveCommand(deps)}`,
    );
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
  // A symlink needs an administrator on Windows, so there the copy itself sits where `current` would point.
  const release = deps.platform === 'win32' ? join(base, 'current') : join(base, 'releases', deps.version);
  rmSync(release, { recursive: true, force: true });
  mkdirSync(release, { recursive: true });
  cpSync(join(root, 'node_modules'), join(release, 'node_modules'), { recursive: true, verbatimSymlinks: true });
  if (deps.platform === 'win32') return join(release, ENTRY);
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
  if (deps.platform === 'win32') {
    await deps.exec('schtasks', ['/Create', '/TN', TASK, '/XML', where.service, '/F']);
    await deps.exec('schtasks', ['/Run', '/TN', TASK]);
    return;
  }
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

/**
 * Ending the task ends only its console, so Crystal goes by the id it recorded, if that is still Crystal. Says whether
 * it stopped one: the id goes stale once that process has gone.
 */
async function stopWindowsCrystal(deps: JoinDeps, where: Layout): Promise<boolean> {
  const pidFile = join(where.base, 'crystal.pid');
  const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : 0;
  if (!pid) return false;
  // tasklist and taskkill are refused over SSH, where `leave` may well run.
  const name = await deps
    .exec('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).ProcessName`])
    .catch(() => '');
  if (name.trim().toLowerCase() !== 'node') return false;
  deps.kill(pid);
  return true;
}

async function stopService(deps: JoinDeps, where: Layout): Promise<void> {
  if (deps.platform === 'win32') {
    await deps.exec('schtasks', ['/End', '/TN', TASK]).catch(() => undefined);
    await deps.exec('schtasks', ['/Delete', '/TN', TASK, '/F']).catch(() => undefined);
    await stopWindowsCrystal(deps, where);
    return;
  }
  if (deps.platform === 'darwin') {
    await deps.exec('launchctl', ['bootout', `gui/${deps.uid}/${LABEL}`]).catch(() => undefined);
  } else {
    await deps.exec('systemctl', ['--user', 'disable', '--now', SERVICE]).catch(() => undefined);
  }
  rmSync(where.service, { force: true });
  if (deps.platform !== 'darwin') await deps.exec('systemctl', ['--user', 'daemon-reload']).catch(() => undefined);
}

/** PATH for the service: npx's temporary folders won't outlive this run. */
function lastingPath(path: string): string {
  return path
    .split(':')
    .filter((entry) => entry && !entry.includes('/_npx/'))
    .join(':');
}

function writeService(mainJs: string, path: string, deps: JoinDeps, where: Layout): void {
  mkdirSync(dirname(where.service), { recursive: true });
  mkdirSync(dirname(where.logFile), { recursive: true });
  const paths = { nodeBin: deps.nodeBin, mainJs, envFile: where.envFile, logFile: where.logFile, path };
  if (deps.platform === 'win32') {
    const script = join(where.base, 'crystal.cmd');
    writeFileSync(script, windowsScript(deps.nodeBin));
    // Task Scheduler reads the file as the UTF-16 its first line says it is.
    writeFileSync(where.service, `\ufeff${windowsTask({ script, user: deps.user })}`, 'utf16le');
  } else {
    writeFileSync(where.service, deps.platform === 'darwin' ? launchdPlist(paths) : systemdUnit(paths));
  }
}

/** Turns this machine into a Kingdom of the hub. Nothing is spent until everything that can be checked has passed. */
export async function runJoin(hubUrl: string, code: string, deps: JoinDeps): Promise<void> {
  const where = layout(deps);
  const root = await checkMachine(deps, where);
  const hub = hubUrl.replace(/\/+$/, '');
  const mainJs = installCopy(root, deps, where.base);
  const { node, token } = await redeemCode(hub, code, deps);

  // Windows' task starts with the user's own PATH, so only these two need one written down.
  const path = lastingPath(deps.path);
  mkdirSync(dirname(where.envFile), { recursive: true });
  writeFileSync(
    where.envFile,
    [
      `CRYSTAL_HUB=${hubSocketUrl(hub)}`,
      `CRYSTAL_NODE=${node}`,
      `CRYSTAL_TOKEN=${token}`,
      'CRYSTAL_DEFAULT_MODE=auto',
      `CRYSTAL_MCP_PORT=${MCP_PORT}`,
      ...(deps.platform === 'win32' ? [] : [`CRYSTAL_LOGIN_SHELL=${deps.shell}`]),
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  chmodSync(where.envFile, 0o600);

  writeService(mainJs, path, deps, where);
  await startService(deps, where);

  deps.log(`Kingdom "${node}" joined ${hub}. It runs as a service and dials out to the hub.`);
  if (deps.platform === 'win32') deps.log('On Windows it runs while you are signed in, and starts at each sign-in.');
  deps.log(`To remove it: ${leaveCommand(deps)}`);
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
  // A stopped process lets go of its files a moment after it's gone.
  rmSync(where.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  deps.log(
    left ? 'This Kingdom has left its hub.' : 'Removed here, but the hub did not answer: remove it from the app.',
  );
}

/** Waits until the agent running here has no busy Quest, and gives up without having changed anything. */
async function waitForQuiet(port: string, deps: JoinDeps): Promise<void> {
  for (let waited = 0; ; waited += ADOPT_POLL_SECONDS) {
    const status = await deps.fetch(`http://127.0.0.1:${port}/status`, {}).catch(() => undefined);
    // No answer means no agent running, so nothing to cut off.
    const { busy = [] } = ((await status?.json().catch(() => undefined)) ?? {}) as { busy?: string[] };
    if (busy.length === 0) return;
    if (waited >= ADOPT_WAIT_SECONDS) {
      throw new Error(
        `Still busy after an hour: ${busy.join(', ')}. Nothing changed; run this again when they finish.`,
      );
    }
    if (waited === 0) deps.log(`Waiting for Quests to finish: ${busy.join(', ')}`);
    await deps.sleep(ADOPT_POLL_SECONDS * 1000);
  }
}

/** Swaps a running agent for the service just written. */
async function replaceService(deps: JoinDeps): Promise<void> {
  if (deps.platform !== 'darwin') {
    await deps.exec('systemctl', ['--user', 'daemon-reload']);
    await deps.exec('systemctl', ['--user', 'enable', SERVICE]);
    await deps.exec('systemctl', ['--user', 'restart', SERVICE]);
    return;
  }
  const job = `gui/${deps.uid}/${LABEL}`;
  await deps.exec('launchctl', ['bootout', job]).catch(() => undefined);
  // bootout returns before the old agent has gone, and starting one while it lingers fails.
  for (let tries = 0; tries < 30; tries++) {
    const gone = await deps.exec('launchctl', ['print', job]).then(
      () => false,
      () => true,
    );
    if (gone) break;
    await deps.sleep(500);
  }
  await deps.exec('launchctl', ['bootstrap', `gui/${deps.uid}`, servicePath(deps.home, 'darwin')]);
}

/**
 * Moves a Kingdom the deploy scripts installed onto this package, so it updates itself from now on. It's the same
 * machine to the hub: the token, name and settings in its env file stay as they are, which `leave` and `join` can't do.
 */
export async function runAdopt(deps: JoinDeps): Promise<void> {
  if (deps.platform !== 'linux' && deps.platform !== 'darwin') throw new Error('adopt runs on Linux and macOS.');
  const where = layout(deps);
  const env = existsSync(where.envFile) ? readFileSync(where.envFile, 'utf8') : '';
  if (!envValue(env, 'CRYSTAL_TOKEN')) throw new Error('This machine is not a Kingdom. Add it from the app instead.');
  const root = installRootOf(deps.mainPath);
  if (!root) throw new Error('adopt has to run from the installed package, not from source.');

  await waitForQuiet(envValue(env, 'CRYSTAL_MCP_PORT') ?? DEFAULT_MCP_PORT, deps);
  const mainJs = installCopy(root, deps, where.base);
  writeService(mainJs, lastingPath(envValue(env, 'PATH') ?? deps.path), deps, where);
  await replaceService(deps);
  deps.log(
    `Kingdom "${envValue(env, 'CRYSTAL_NODE') ?? ''}" now runs ${deps.version} and updates itself from its hub.`,
  );
}

/** Restarts the running service so it picks up the release; false when nothing was running to restart. */
async function restartService(deps: JoinDeps, where: Layout): Promise<boolean> {
  if (deps.platform === 'win32') return stopWindowsCrystal(deps, where); // `crystal.cmd` brings it back
  if (deps.platform === 'darwin') {
    await deps.exec('launchctl', ['kickstart', '-k', `gui/${deps.uid}/${LABEL}`]);
    return true;
  }
  await deps.exec('systemctl', ['--user', 'restart', SERVICE]);
  return true;
}

/** Goes back to the release before the last self-update, and stays there until the hub names a newer one still. */
export async function runRollback(deps: JoinDeps): Promise<void> {
  const where = layout(deps);
  if (!existsSync(where.envFile)) throw new Error('This machine is not a Kingdom.');
  const version = rollbackRelease({ base: where.base, platform: deps.platform });
  const restarted = await restartService(deps, where);
  deps.log(
    restarted
      ? `Back on ${version}. This Kingdom won't take the release it left again.`
      : `${version} runs at the next start, and this Kingdom won't take the release it left again. Crystal could not be found to restart it now.`,
  );
}
