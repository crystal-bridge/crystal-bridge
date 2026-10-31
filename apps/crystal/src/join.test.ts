import { execFile } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { LEAVE_COMMAND, LEAVE_COMMAND_WINDOWS } from '@crystal-bridge/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hubHttpUrl,
  hubSocketUrl,
  installRootOf,
  launchdPlist,
  runJoin,
  runLeave,
  servicePath,
  systemdUnit,
  type JoinDeps,
} from './join.js';

const run = promisify(execFile);

const paths = {
  nodeBin: '/opt/node/bin/node',
  mainJs: '/h/main.js',
  envFile: '/h/crystal.env',
  logFile: '/h/c.log',
  path: '/opt/node/bin:/usr/bin',
};

describe('service definitions', () => {
  it('a systemd user unit runs the agent with its env file and keeps background work on a restart', () => {
    const unit = systemdUnit(paths);
    expect(unit).toContain('ExecStart=/opt/node/bin/node --env-file=/h/crystal.env /h/main.js');
    expect(unit).toContain('KillMode=process');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('a launchd plist does the same and restarts after a failure', () => {
    const plist = launchdPlist(paths);
    expect(plist).toContain('<string>--env-file=/h/crystal.env</string>');
    expect(plist).toContain('<string>/h/main.js</string>');
    expect(plist).toContain('<key>SuccessfulExit</key>');
  });

  it('both set PATH themselves: --env-file does not replace a variable the service manager already set', () => {
    expect(systemdUnit(paths)).toContain('Environment=PATH=/opt/node/bin:/usr/bin');
    expect(launchdPlist(paths)).toContain('<key>PATH</key>');
    expect(launchdPlist(paths)).toContain('<string>/opt/node/bin:/usr/bin</string>');
  });

  it('neither one holds the token', () => {
    expect(systemdUnit(paths)).not.toContain('TOKEN');
    expect(launchdPlist(paths)).not.toContain('TOKEN');
  });
});

describe('hub URLs', () => {
  it('turns the hub address into its node socket, and back', () => {
    expect(hubSocketUrl('https://hub.example.com/')).toBe('wss://hub.example.com/node');
    expect(hubSocketUrl('http://127.0.0.1:7700')).toBe('ws://127.0.0.1:7700/node');
    expect(hubHttpUrl('wss://hub.example.com/node')).toBe('https://hub.example.com');
    expect(hubHttpUrl('ws://127.0.0.1:7700/node')).toBe('http://127.0.0.1:7700');
  });
});

describe('installRootOf', () => {
  it('reads a Windows path', () => {
    expect(installRootOf('C:\\c\\node_modules\\@crystal-bridge\\kingdom\\dist\\main.js')).toBe('C:/c');
  });

  it('finds the folder holding the installed package', () => {
    expect(installRootOf('/c/_npx/ab/node_modules/@crystal-bridge/kingdom/dist/main.js')).toBe('/c/_npx/ab');
  });

  it('is nothing when running from source', () => {
    expect(installRootOf('/home/me/code/crystal-bridge/apps/crystal/src/main.ts')).toBeUndefined();
  });
});

// A symlink needs an administrator on Windows, and these install the Unix way.
const onUnix = it.skipIf(process.platform === 'win32');

describe('join and leave', () => {
  let dir: string;
  let home: string;
  let npx: string;
  let calls: string[];
  let lines: string[];
  let killed: number[];
  let answers: Record<string, string | Error>;
  let reply: { status: number; body: unknown };
  let fetchHub: ReturnType<typeof vi.fn>;

  function deps(platform: NodeJS.Platform = 'linux'): JoinDeps {
    return {
      home,
      platform,
      user: 'me',
      uid: 501,
      version: '0.2.0',
      mainPath: join(npx, 'node_modules/@crystal-bridge/kingdom/dist/main.js'),
      nodeBin: '/opt/node/bin/node',
      path: `/c/_npx/ab/node_modules/.bin:/opt/node/bin:/usr/bin`,
      claudeBin: 'claude',
      shell: '/bin/zsh',
      fetch: fetchHub as unknown as JoinDeps['fetch'],
      async exec(file, args) {
        const call = [file, ...args].join(' ');
        calls.push(call);
        const answer = Object.entries(answers).find(([key]) => call.includes(key))?.[1] ?? '';
        if (answer instanceof Error) throw answer;
        return answer;
      },
      log: (line) => lines.push(line),
      kill: (pid) => killed.push(pid),
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cb-join-'));
    home = join(dir, 'home');
    npx = join(dir, 'npx');
    mkdirSync(home);
    mkdirSync(join(npx, 'node_modules/@crystal-bridge/kingdom/dist'), { recursive: true });
    writeFileSync(join(npx, 'node_modules/@crystal-bridge/kingdom/dist/main.js'), '// agent');
    calls = [];
    lines = [];
    killed = [];
    answers = {
      '--version': '2.1.314 (Claude Code)',
      'auth status': JSON.stringify({ loggedIn: true, email: 'someone@example.com' }),
      'show-user': 'yes',
    };
    reply = { status: 200, body: { node: 'node-c', token: 'the-token' } };
    fetchHub = vi.fn(async () => ({
      ok: reply.status < 300,
      status: reply.status,
      json: async () => reply.body,
    }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const envFile = () => join(home, '.config/crystal-bridge/crystal.env');
  const windowsBase = () => join(home, 'AppData/Local/crystal-bridge');
  const windowsDeps = () => ({ ...deps('win32'), nodeBin: 'C:\\node\\node.exe' });

  it('registers a sign-in task on Windows, keeping the token out of it', async () => {
    await runJoin('https://hub.example.com', 'CODE', windowsDeps());

    const env = readFileSync(join(windowsBase(), 'crystal.env'), 'utf8');
    expect(env).toContain('CRYSTAL_TOKEN=the-token');
    expect(env).not.toContain('CRYSTAL_LOGIN_SHELL');

    const file = join(windowsBase(), 'task.xml');
    const bytes = readFileSync(file);
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
    const task = bytes.toString('utf16le');
    expect(task).toContain('<LogonTrigger>');
    expect(task).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(task).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(task).toContain('<UserId>me</UserId>');
    expect(task).not.toContain('the-token');

    const script = readFileSync(join(windowsBase(), 'crystal.cmd'), 'utf8');
    expect(task).toContain(`<Arguments>--headless "${join(windowsBase(), 'crystal.cmd')}"</Arguments>`);
    expect(script).toContain('"C:\\node\\node.exe" --env-file="%~dp0crystal.env" "%~dp0current\\node_modules\\');
    expect(script).toContain('>> "%~dp0crystal.log" 2>&1');
    expect(script).toContain('set "CRYSTAL_PID_FILE=%~dp0crystal.pid"');
    // A crash exits with a negative code, which `errorlevel 1` would take for success.
    expect(script).toContain('if %errorlevel% equ 0 exit /b 0');
    expect(script).not.toContain('the-token');
    expect(
      script
        .split('\n')
        .slice(0, -1)
        .every((line) => line.endsWith('\r')),
    ).toBe(true);

    expect(calls).toContain(`schtasks /Create /TN CrystalBridgeKingdom /XML ${file} /F`);
    expect(calls).toContain('schtasks /Run /TN CrystalBridgeKingdom');
    expect(lines.join('\n')).toMatch(/signed in/);
    expect(lines.join('\n')).toContain(LEAVE_COMMAND_WINDOWS);
    const copy = join(windowsBase(), 'current/node_modules/@crystal-bridge/kingdom/dist/main.js');
    expect(existsSync(copy)).toBe(true);
  });

  it('names the Windows way to leave when this one has already joined', async () => {
    await runJoin('https://hub.example.com', 'CODE', windowsDeps());
    await expect(runJoin('https://hub.example.com', 'CODE', windowsDeps())).rejects.toThrow(LEAVE_COMMAND_WINDOWS);
  });

  it('stops the task and removes everything on leaving on Windows', async () => {
    await runJoin('https://hub.example.com', 'CODE', windowsDeps());
    calls.length = 0;
    await runLeave(windowsDeps());

    expect(calls).toEqual(['schtasks /End /TN CrystalBridgeKingdom', 'schtasks /Delete /TN CrystalBridgeKingdom /F']);
    expect(killed).toEqual([]);
    expect(existsSync(windowsBase())).toBe(false);
  });

  it('stops Crystal itself on leaving on Windows, since ending the task only ends its console', async () => {
    await runJoin('https://hub.example.com', 'CODE', windowsDeps());
    writeFileSync(join(windowsBase(), 'crystal.pid'), '4242');
    answers['Get-Process -Id 4242'] = 'node\r\n';
    await runLeave(windowsDeps());

    expect(killed).toEqual([4242]);
    expect(existsSync(windowsBase())).toBe(false);
  });

  it('leaves alone whatever now has the recorded process id', async () => {
    await runJoin('https://hub.example.com', 'CODE', windowsDeps());
    writeFileSync(join(windowsBase(), 'crystal.pid'), '4242');
    answers['Get-Process -Id 4242'] = 'notepad\r\n';
    await runLeave(windowsDeps());

    expect(killed).toEqual([]);
  });

  // The script for real: a space in the path is the usual case, since a Windows folder is named after its user, and a
  // crash exits with a negative code. The console around it is left out, as it only runs under Task Scheduler.
  it.runIf(process.platform === 'win32')(
    'runs Crystal from a spaced path and restarts it after a crash',
    async () => {
      const deep = join(dir, 'a user');
      const windows = { ...windowsDeps(), home: deep, nodeBin: process.execPath };
      mkdirSync(deep);
      await runJoin('https://hub.example.com', 'CODE', windows);
      const base = join(deep, 'AppData/Local/crystal-bridge');
      const crashed = join(base, 'crashed');
      writeFileSync(
        join(base, 'current/node_modules/@crystal-bridge/kingdom/dist/main.js'),
        `const fs = process.getBuiltinModule('fs');
       console.log('started as', process.env.CRYSTAL_NODE);
       if (!fs.existsSync(${JSON.stringify(crashed)})) { fs.writeFileSync(${JSON.stringify(crashed)}, ''); process.exit(-1); }`,
      );

      await run('cmd.exe', ['/c', join(base, 'crystal.cmd')]);

      expect(readFileSync(join(base, 'crystal.log'), 'utf8').match(/started as node-c/g)).toHaveLength(2);
    },
    20_000,
  );

  const current = () => join(home, '.local/share/crystal-bridge/current');

  onUnix('installs a lasting copy, writes the token owner-only and starts the service on Linux', async () => {
    await runJoin('https://hub.example.com', 'CODE', deps());

    expect(fetchHub).toHaveBeenCalledWith(
      'https://hub.example.com/api/join',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ code: 'CODE' }) }),
    );
    expect(readlinkSync(current())).toContain('releases/0.2.0');
    expect(existsSync(join(current(), 'node_modules/@crystal-bridge/kingdom/dist/main.js'))).toBe(true);
    const env = readFileSync(envFile(), 'utf8');
    expect(env).toContain('CRYSTAL_HUB=wss://hub.example.com/node\n');
    expect(env).toContain('CRYSTAL_NODE=node-c\n');
    expect(env).toContain('CRYSTAL_TOKEN=the-token\n');
    expect(statSync(envFile()).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(home, '.config/systemd/user/crystal.service'), 'utf8')).toContain(
      join(current(), 'node_modules/@crystal-bridge/kingdom/dist/main.js'),
    );
    expect(calls).toContain('systemctl --user enable --now crystal.service');
  });

  onUnix('says how to leave with a command that works: the bin is not on PATH after an npx install', async () => {
    await runJoin('https://hub.example.com', 'CODE', deps());
    expect(lines.join('\n')).toContain(LEAVE_COMMAND);
  });

  onUnix('never prints the token or the login-s email', async () => {
    await runJoin('https://hub.example.com', 'CODE', deps());
    expect(lines.join('\n')).not.toContain('the-token');
    expect(lines.join('\n')).not.toContain('someone@example.com');
  });

  onUnix('leaves the temporary npx folder off the PATH the service keeps', async () => {
    await runJoin('https://hub.example.com', 'CODE', deps());
    expect(readFileSync(servicePath(home, 'linux'), 'utf8')).toContain('Environment=PATH=/opt/node/bin:/usr/bin\n');
  });

  onUnix('keeps the login shell, because a service manager may not set SHELL', async () => {
    await runJoin('https://hub.example.com', 'CODE', deps());
    expect(readFileSync(envFile(), 'utf8')).toContain('CRYSTAL_LOGIN_SHELL=/bin/zsh\n');
  });

  onUnix('starts a launchd agent on macOS', async () => {
    await runJoin('https://hub.example.com', 'CODE', deps('darwin'));
    const plist = servicePath(home, 'darwin');
    expect(existsSync(plist)).toBe(true);
    expect(calls).toContain(`launchctl bootstrap gui/501 ${plist}`);
    expect(calls.some((call) => call.startsWith('systemctl'))).toBe(false);
  });

  onUnix('turns lingering on when it is off, and says so', async () => {
    answers['show-user'] = 'no';
    await runJoin('https://hub.example.com', 'CODE', deps());
    expect(calls).toContain('sudo loginctl enable-linger me');
    expect(lines.join('\n')).toMatch(/linger/i);
  });

  onUnix('still finishes when lingering cannot be turned on, with a warning', async () => {
    answers['show-user'] = 'no';
    answers['enable-linger'] = new Error('no sudo');
    await runJoin('https://hub.example.com', 'CODE', deps());
    expect(calls).toContain('systemctl --user enable --now crystal.service');
    expect(lines.join('\n')).toContain('sudo loginctl enable-linger me');
  });

  onUnix('refuses a machine that is already a Kingdom, without spending the code', async () => {
    mkdirSync(join(home, '.config/crystal-bridge'), { recursive: true });
    writeFileSync(envFile(), 'CRYSTAL_TOKEN=old\n');
    await expect(runJoin('https://hub.example.com', 'CODE', deps())).rejects.toThrow(/already a Kingdom/);
    expect(fetchHub).not.toHaveBeenCalled();
    expect(readFileSync(envFile(), 'utf8')).toBe('CRYSTAL_TOKEN=old\n');
  });

  onUnix('refuses a machine without the CLI, without spending the code', async () => {
    answers['--version'] = new Error('ENOENT');
    await expect(runJoin('https://hub.example.com', 'CODE', deps())).rejects.toThrow(/Claude Code/);
    expect(fetchHub).not.toHaveBeenCalled();
  });

  onUnix('says how to sign in when the CLI is signed out, without spending the code', async () => {
    answers['auth status'] = JSON.stringify({ loggedIn: false });
    await expect(runJoin('https://hub.example.com', 'CODE', deps())).rejects.toThrow(/claude auth login/);
    expect(fetchHub).not.toHaveBeenCalled();
  });

  onUnix('refuses Windows for now, plainly', async () => {
    await expect(runJoin('https://hub.example.com', 'CODE', deps('freebsd'))).rejects.toThrow(
      /Linux, macOS and Windows/,
    );
  });

  onUnix('reports a refused code and writes nothing that makes it a Kingdom', async () => {
    reply = { status: 401, body: { error: 'that code is wrong, used or expired' } };
    await expect(runJoin('https://hub.example.com', 'CODE', deps())).rejects.toThrow(/wrong, used or expired/);
    expect(existsSync(envFile())).toBe(false);
    expect(calls.some((call) => call.includes('enable --now'))).toBe(false);
  });

  onUnix('refuses to run from source, where there is nothing lasting to copy', async () => {
    const fromSource = { ...deps(), mainPath: '/home/me/code/crystal-bridge/apps/crystal/src/main.ts' };
    await expect(runJoin('https://hub.example.com', 'CODE', fromSource)).rejects.toThrow(/installed package/);
    expect(fetchHub).not.toHaveBeenCalled();
  });

  onUnix('leave gives up the token, stops the service and removes everything it installed', async () => {
    await runJoin('https://hub.example.com', 'CODE', deps());
    fetchHub.mockClear();
    calls = [];
    reply = { status: 204, body: {} };

    await runLeave(deps());

    expect(fetchHub).toHaveBeenCalledWith(
      'https://hub.example.com/api/leave',
      expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer the-token' }) }),
    );
    expect(calls).toContain('systemctl --user disable --now crystal.service');
    expect(existsSync(envFile())).toBe(false);
    expect(existsSync(servicePath(home, 'linux'))).toBe(false);
    expect(() => lstatSync(current())).toThrow();
    expect(existsSync(join(home, '.local/share/crystal-bridge'))).toBe(false);
  });

  onUnix('leave finishes even if the hub cannot be reached, and says the token is still live', async () => {
    await runJoin('https://hub.example.com', 'CODE', deps());
    fetchHub.mockRejectedValue(new Error('offline'));
    await runLeave(deps());
    expect(existsSync(envFile())).toBe(false);
    expect(lines.join('\n')).toMatch(/remove it from the app/i);
  });

  onUnix('leave refuses a machine that is not a Kingdom', async () => {
    await expect(runLeave(deps())).rejects.toThrow(/not a Kingdom/);
  });
});
