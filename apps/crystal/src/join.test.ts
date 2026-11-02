import { installRootOf } from './release.js';
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
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { LEAVE_COMMAND, LEAVE_COMMAND_WINDOWS } from '@crystal-bridge/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hubHttpUrl,
  hubSocketUrl,
  launchdPlist,
  portTaken,
  runAdopt,
  runJoin,
  runLeave,
  runRollback,
  servicePath,
  stableNode,
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

  const spaced = {
    nodeBin: '/srv/a b/node',
    mainJs: '/srv/a b/main.js',
    envFile: '/srv/a b/crystal.env',
    logFile: '/srv/a b/c.log',
    path: '/mnt/c/Program Files/nodejs:/usr/bin',
  };

  it('a unit quotes a space, which would otherwise split an argument or cut PATH short', () => {
    const unit = systemdUnit(spaced);
    expect(unit).toContain('ExecStart="/srv/a b/node" "--env-file=/srv/a b/crystal.env" "/srv/a b/main.js"\n');
    expect(unit).toContain('Environment="PATH=/mnt/c/Program Files/nodejs:/usr/bin"\n');
  });

  it('a unit escapes what systemd would otherwise expand or end a quote on', () => {
    const unit = systemdUnit({ ...paths, mainJs: '/h/100% "$HOME"\\x.js', path: '/a$b:/c%d' });
    expect(unit).toContain(' "/h/100%% \\"$$HOME\\"\\\\x.js"\n');
    // Environment= has no $ substitution, so only the specifier is doubled.
    expect(unit).toContain('Environment=PATH=/a$b:/c%%d\n');
  });

  const awkward = {
    nodeBin: '/h/R&D/node',
    mainJs: '/h/R&D/main.js',
    envFile: '/h/R&D/crystal.env',
    logFile: '/h/R&D/<c>.log',
    path: '/h/R&D/bin:/usr/bin',
  };

  it('a plist escapes every path, so an ampersand in one does not break the file', () => {
    const plist = launchdPlist(awkward);
    expect(plist).toContain('<string>/h/R&amp;D/node</string>');
    expect(plist).toContain('<string>--env-file=/h/R&amp;D/crystal.env</string>');
    expect(plist).toContain('<string>/h/R&amp;D/main.js</string>');
    expect(plist).toContain('<string>/h/R&amp;D/bin:/usr/bin</string>');
    expect(plist).toContain('<string>/h/R&amp;D/&lt;c&gt;.log</string>');
    expect(plist.replaceAll(/&(amp|lt|gt);/g, '')).not.toMatch(/&/);
  });

  it.runIf(process.platform === 'darwin')('plutil reads that plist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-plist-'));
    const file = join(dir, 'a.plist');
    writeFileSync(file, launchdPlist(awkward));
    await run('plutil', ['-lint', file]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('stableNode', () => {
  let dir: string;
  let real: string;
  let bin: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cb-node-'));
    real = join(dir, 'Cellar/node/25.0.0/bin/node');
    bin = join(dir, 'bin');
    mkdirSync(dirname(real), { recursive: true });
    mkdirSync(bin);
    writeFileSync(real, '');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // A symlink needs an administrator on Windows.
  const onUnix = it.skipIf(process.platform === 'win32');

  onUnix('takes the link on PATH that a package manager keeps pointing at its newest node', () => {
    symlinkSync(real, join(bin, 'node'));
    expect(stableNode(real, `/usr/bin:${dirname(real)}:${bin}`, 'darwin')).toBe(join(bin, 'node'));
  });

  onUnix('keeps the running node when the one on PATH is another node', () => {
    writeFileSync(join(bin, 'node'), '');
    expect(stableNode(real, bin, 'linux')).toBe(real);
  });

  onUnix('keeps the running node when nothing on PATH leads to it', () => {
    expect(stableNode(real, `/usr/bin:${bin}`, 'linux')).toBe(real);
  });

  onUnix('never writes down a relative PATH entry, which means nothing to a service', () => {
    symlinkSync(real, join(bin, 'node'));
    expect(stableNode(real, 'bin', 'linux')).toBe(real);
  });

  onUnix('reads a Windows PATH', () => {
    symlinkSync(real, join(bin, 'node.exe'));
    expect(stableNode(real, `C:\\nope;${bin}`, 'win32')).toBe(join(bin, 'node.exe'));
  });

  it('copes with a running node it cannot find', () => {
    expect(stableNode('/gone/node', bin, 'linux')).toBe('/gone/node');
  });
});

describe('portTaken', () => {
  it('says whether something here already holds a port', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    expect(await portTaken(port)).toBe(true);
    await new Promise((resolve) => server.close(resolve));
    expect(await portTaken(port)).toBe(false);
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
      nodeVersion: '22.12.0',
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
      sleep: async () => undefined,
      portTaken: async () => false,
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

  describe('who the Windows task runs as', () => {
    const whoami = '"azuread\\me","S-1-12-1-11-22-33-44"\r\n';
    const task = () => readFileSync(join(windowsBase(), 'task.xml')).toString('utf16le');

    it('names the user by SID, since a bare name can match nothing on an Entra or domain PC', async () => {
      answers['whoami /user'] = whoami;
      await runJoin('https://hub.example.com', 'CODE', windowsDeps());
      expect(task().match(/<UserId>[^<]*<\/UserId>/g)).toEqual([
        '<UserId>S-1-12-1-11-22-33-44</UserId>',
        '<UserId>S-1-12-1-11-22-33-44</UserId>',
      ]);
    });

    it('falls back to the plain name when whoami gives nothing it can read', async () => {
      answers['whoami /user'] = new Error('no whoami');
      await runJoin('https://hub.example.com', 'CODE', windowsDeps());
      expect(task()).toContain('<UserId>me</UserId>');
    });

    /** A Task Scheduler that only takes the task when it names this user this way. */
    function takingOnly(form: string): JoinDeps {
      const windows = windowsDeps();
      return {
        ...windows,
        async exec(file, args) {
          if (args.includes('/Create') && !task().includes(`<UserId>${form}</UserId>`)) {
            throw new Error('No mapping between account names and security IDs was done.');
          }
          return windows.exec(file, args);
        },
      };
    }

    it('tries the account name next when Task Scheduler turns the SID down', async () => {
      answers['whoami /user'] = whoami;
      await runJoin('https://hub.example.com', 'CODE', takingOnly('azuread\\me'));
      expect(task()).toContain('<UserId>azuread\\me</UserId>');
      expect(calls).toContain('schtasks /Run /TN CrystalBridgeKingdom');
    });

    it('tries a throwaway task before the code is spent, and leaves none behind', async () => {
      await runJoin('https://hub.example.com', 'CODE', windowsDeps());
      const file = join(windowsBase(), 'task.xml');
      const tried = calls.indexOf(`schtasks /Create /TN CrystalBridgeKingdomCheck /XML ${file} /F`);
      expect(tried).toBeGreaterThan(-1);
      expect(calls[tried + 1]).toBe('schtasks /Delete /TN CrystalBridgeKingdomCheck /F');
    });

    it('keeps the code when Task Scheduler takes no form of the user', async () => {
      answers['whoami /user'] = whoami;
      await expect(runJoin('https://hub.example.com', 'CODE', takingOnly('nobody'))).rejects.toThrow(
        /Task Scheduler.*No mapping/s,
      );
      expect(fetchHub).not.toHaveBeenCalled();
      expect(existsSync(join(windowsBase(), 'crystal.env'))).toBe(false);
      expect(existsSync(join(windowsBase(), 'task.xml'))).toBe(false);
    });
  });

  it.skipIf(process.platform === 'win32')('writes the stable node into the Windows script too', async () => {
    const programs = join(dir, 'programs');
    const nvm = join(dir, 'nvm/v22');
    mkdirSync(programs);
    mkdirSync(nvm, { recursive: true });
    writeFileSync(join(nvm, 'node.exe'), '');
    symlinkSync(join(nvm, 'node.exe'), join(programs, 'node.exe'));
    await runJoin('https://hub.example.com', 'CODE', {
      ...windowsDeps(),
      nodeBin: join(nvm, 'node.exe'),
      path: `C:\\Windows;${programs}`,
    });
    expect(readFileSync(join(windowsBase(), 'crystal.cmd'), 'utf8')).toContain(
      `"${join(programs, 'node.exe')}" --env-file`,
    );
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

  describe('rollback on Windows', () => {
    function afterAnUpdate(): string {
      const base = windowsBase();
      for (const [folder, version] of Object.entries({ current: '1.1.0', previous: '1.0.0' })) {
        const root = join(base, folder, 'node_modules/@crystal-bridge/kingdom');
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
      }
      writeFileSync(join(base, 'crystal.env'), 'CRYSTAL_TOKEN=t\n');
      return base;
    }

    it('says it’s back once the running Crystal has been stopped for the script to restart', async () => {
      const base = afterAnUpdate();
      writeFileSync(join(base, 'crystal.pid'), '4242');
      answers['Get-Process -Id 4242'] = 'node\r\n';
      await runRollback(windowsDeps());
      expect(killed).toEqual([4242]);
      expect(lines.join('\n')).toContain('Back on 1.0.0');
    });

    it('doesn’t claim that when no Crystal was there to stop: the id can be stale', async () => {
      const base = afterAnUpdate();
      writeFileSync(join(base, 'crystal.pid'), '4242');
      await runRollback(windowsDeps());
      expect(killed).toEqual([]);
      expect(lines.join('\n')).not.toContain('Back on');
      expect(lines.join('\n')).toContain('1.0.0 runs at the next start');
    });
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

  // A self-update exits so the script comes round again: it swaps the folders between runs, while nothing holds them.
  it.runIf(process.platform === 'win32')(
    'swaps in the next release between runs and keeps the last one',
    async () => {
      const deep = join(dir, 'a user');
      const windows = { ...windowsDeps(), home: deep, nodeBin: process.execPath };
      mkdirSync(deep);
      await runJoin('https://hub.example.com', 'CODE', windows);
      const base = join(deep, 'AppData/Local/crystal-bridge');
      const entry = 'node_modules/@crystal-bridge/kingdom/dist/main.js';
      const says = (name: string, code: number) => `console.log('release ${name}'); process.exitCode = ${code};`;
      writeFileSync(join(base, 'current', entry), says('old', 75));
      mkdirSync(join(base, 'next', dirname(entry)), { recursive: true });
      writeFileSync(join(base, 'next', entry), says('new', 0));
      await run('cmd.exe', ['/c', join(base, 'crystal.cmd')]);

      expect(readFileSync(join(base, 'crystal.log'), 'utf8')).toContain('release new');
      expect(readFileSync(join(base, 'current', entry), 'utf8')).toContain('release new');
      expect(readFileSync(join(base, 'previous', entry), 'utf8')).toContain('release old');
      expect(existsSync(join(base, 'next'))).toBe(false);
    },
    20_000,
  );

  // A power cut can land between two of those moves, and it must not leave a Kingdom that can't start.
  it.runIf(process.platform === 'win32')(
    'starts from what is there when a swap was cut off',
    async () => {
      const deep = join(dir, 'a user');
      const windows = { ...windowsDeps(), home: deep, nodeBin: process.execPath };
      mkdirSync(deep);
      await runJoin('https://hub.example.com', 'CODE', windows);
      const base = join(deep, 'AppData/Local/crystal-bridge');
      const entry = 'node_modules/@crystal-bridge/kingdom/dist/main.js';
      const says = (name: string) => `console.log('release ${name}');`;
      rmSync(join(base, 'current'), { recursive: true });
      mkdirSync(join(base, 'previous', dirname(entry)), { recursive: true });
      writeFileSync(join(base, 'previous', entry), says('old'));
      mkdirSync(join(base, 'next', dirname(entry)), { recursive: true });
      writeFileSync(join(base, 'next', entry), says('new'));

      await run('cmd.exe', ['/c', join(base, 'crystal.cmd')]);

      expect(readFileSync(join(base, 'crystal.log'), 'utf8')).toContain('release new');
      expect(readFileSync(join(base, 'previous', entry), 'utf8')).toContain('release old');
      expect(existsSync(join(base, 'next'))).toBe(false);
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

  describe('checks before the code is spent', () => {
    const refusedBeforeSpending = async (made: JoinDeps, message: RegExp): Promise<void> => {
      await expect(runJoin('https://hub.example.com', 'CODE', made)).rejects.toThrow(message);
      expect(fetchHub).not.toHaveBeenCalled();
      expect(existsSync(envFile())).toBe(false);
    };

    onUnix('refuses a node older than the package needs', async () => {
      await refusedBeforeSpending({ ...deps(), nodeVersion: '20.11.0' }, /Node 22.*20\.11\.0/);
    });

    onUnix('refuses Linux with no user service manager to reach', async () => {
      answers['systemctl --user show-environment'] = new Error('Failed to connect to bus');
      await refusedBeforeSpending(deps(), /systemctl --user/);
    });

    onUnix('refuses macOS with no graphical session, which launchd agents need', async () => {
      answers['launchctl print gui/501'] = new Error('Could not find domain');
      await refusedBeforeSpending(deps('darwin'), /signed in at the Mac/);
    });

    onUnix('refuses a port something else holds, naming the likely second account', async () => {
      await refusedBeforeSpending({ ...deps(), portTaken: async (port) => port === 7711 }, /7711.*another account/s);
    });
  });

  describe('after starting the service', () => {
    /** The agent's own /status: nothing answering yet, or the hub's reply to a join. */
    function statusAnswers(status: () => Promise<unknown>): void {
      fetchHub.mockImplementation(async (url: string) => {
        if (!url.endsWith('/status')) return { ok: true, status: 200, json: async () => reply.body };
        return { ok: true, status: 200, json: status };
      });
    }

    onUnix('waits for the agent to answer on its port before saying it joined', async () => {
      let tries = 0;
      statusAnswers(async () => {
        tries++;
        if (tries < 4) throw new Error('not up');
        return { node: 'node-c' };
      });
      await runJoin('https://hub.example.com', 'CODE', deps());
      expect(fetchHub).toHaveBeenCalledWith('http://127.0.0.1:7711/status', expect.anything());
      expect(tries).toBe(4);
      expect(lines.join('\n')).toContain('joined');
    });

    onUnix('reports a service that never answers, and points at its log, instead of saying it joined', async () => {
      fetchHub.mockImplementation(async (url: string) => {
        if (url.endsWith('/status')) throw new Error('fetch failed');
        return { ok: true, status: 200, json: async () => reply.body };
      });
      const sleep = vi.fn(async () => undefined);
      await expect(runJoin('https://hub.example.com', 'CODE', { ...deps(), sleep })).rejects.toThrow(
        /did not answer.*journalctl --user -u crystal\.service/s,
      );
      expect(sleep.mock.calls.length).toBeGreaterThanOrEqual(19);
      expect(lines.join('\n')).not.toContain('joined');
    });

    onUnix('names the log file on macOS, where launchd writes one', async () => {
      statusAnswers(async () => {
        throw new Error('not up');
      });
      await expect(runJoin('https://hub.example.com', 'CODE', deps('darwin'))).rejects.toThrow(
        join(home, 'Library/Logs/crystal-bridge/crystal.log'),
      );
    });

    it('names the log file on Windows', async () => {
      statusAnswers(async () => {
        throw new Error('not up');
      });
      await expect(runJoin('https://hub.example.com', 'CODE', windowsDeps())).rejects.toThrow(
        join(windowsBase(), 'crystal.log'),
      );
    });

    onUnix('does not take another account’s Kingdom on that port for its own', async () => {
      statusAnswers(async () => ({ node: 'someone-else' }));
      await expect(runJoin('https://hub.example.com', 'CODE', deps())).rejects.toThrow(/someone-else/);
      expect(lines.join('\n')).not.toContain('joined');
    });

    onUnix('says how to get out when the service will not start at all', async () => {
      answers['enable --now'] = new Error('Failed to start');
      await expect(runJoin('https://hub.example.com', 'CODE', deps())).rejects.toThrow(/Failed to start.*leave/s);
    });
  });

  onUnix('writes a link on PATH rather than the versioned folder a Homebrew node runs from', async () => {
    const cellar = join(dir, 'Cellar/node/25.0.0/bin');
    const brew = join(dir, 'brew-bin');
    mkdirSync(cellar, { recursive: true });
    mkdirSync(brew);
    writeFileSync(join(cellar, 'node'), '');
    symlinkSync(join(cellar, 'node'), join(brew, 'node'));
    const homebrew = { ...deps('darwin'), nodeBin: join(cellar, 'node'), path: `${brew}:/usr/bin` };
    await runJoin('https://hub.example.com', 'CODE', homebrew);
    const plist = readFileSync(servicePath(home, 'darwin'), 'utf8');
    expect(plist).toContain(`<string>${join(brew, 'node')}</string>`);
    expect(plist).not.toContain('Cellar');
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

  describe('adopt', () => {
    const quiet = { ok: true, status: 200, json: async () => ({ busy: [] }) };

    function deployedKingdom(): void {
      mkdirSync(join(home, '.config/crystal-bridge'), { recursive: true });
      writeFileSync(
        envFile(),
        'CRYSTAL_HUB=wss://hub/node\nCRYSTAL_NODE=mine\nCRYSTAL_TOKEN=keep\nCRYSTAL_CHROME=1\nCRYSTAL_ENGINES=stream,interactive\n' +
          'CRYSTAL_MCP_PORT=7711\nPATH=/from/env:/usr/bin\n',
      );
    }

    onUnix('moves a deployed Kingdom onto the package, keeping its token, name and settings', async () => {
      deployedKingdom();
      const env = readFileSync(envFile(), 'utf8');
      fetchHub.mockResolvedValue(quiet);
      await runAdopt(deps());
      expect(readFileSync(envFile(), 'utf8')).toBe(env);
      expect(readlinkSync(join(home, '.local/share/crystal-bridge/current'))).toMatch(/releases\/0\.2\.0$/);
      const unit = readFileSync(servicePath(home, 'linux'), 'utf8');
      expect(unit).toContain('crystal-bridge/current/node_modules/@crystal-bridge/kingdom/dist/main.js');
      expect(unit).toContain('Environment=PATH=/from/env:/usr/bin');
      expect(calls).toContain('systemctl --user restart crystal.service');
      expect(fetchHub.mock.calls[0]?.[0]).toBe('http://127.0.0.1:7711/status');
      expect(fetchHub).toHaveBeenCalledTimes(1);
    });

    onUnix('waits for the agent to go idle before changing anything', async () => {
      deployedKingdom();
      fetchHub
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ busy: ['q1'] }) })
        .mockResolvedValue(quiet);
      const sleep = vi.fn(async () => {
        expect(existsSync(join(home, '.local/share/crystal-bridge/current'))).toBe(false);
      });
      await runAdopt({ ...deps(), sleep });
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(calls).toContain('systemctl --user restart crystal.service');
    });

    onUnix('gives up unchanged when a Quest stays busy', async () => {
      deployedKingdom();
      fetchHub.mockResolvedValue({ ok: true, status: 200, json: async () => ({ busy: ['q1'] }) });
      await expect(runAdopt(deps())).rejects.toThrow(/still busy.*q1/i);
      expect(existsSync(join(home, '.local/share/crystal-bridge/current'))).toBe(false);
      expect(calls).toEqual([]);
    });

    onUnix('repairs a service left on a versioned node, finding the link on the PATH it runs from', async () => {
      deployedKingdom();
      fetchHub.mockResolvedValue(quiet);
      const cellar = join(dir, 'Cellar/node/25.0.0/bin');
      const brew = join(dir, 'brew-bin');
      mkdirSync(cellar, { recursive: true });
      mkdirSync(brew);
      writeFileSync(join(cellar, 'node'), '');
      symlinkSync(join(cellar, 'node'), join(brew, 'node'));
      await runAdopt({ ...deps(), nodeBin: join(cellar, 'node'), path: `${brew}:/usr/bin` });
      expect(readFileSync(servicePath(home, 'linux'), 'utf8')).toContain(`ExecStart=${join(brew, 'node')} `);
    });

    onUnix('run from the release it is already on, keeps that release instead of deleting it', async () => {
      deployedKingdom();
      fetchHub.mockResolvedValue(quiet);
      const release = join(home, '.local/share/crystal-bridge/releases/0.2.0');
      const entry = join(release, 'node_modules/@crystal-bridge/kingdom/dist/main.js');
      mkdirSync(dirname(entry), { recursive: true });
      writeFileSync(entry, '// agent');
      await runAdopt({ ...deps(), mainPath: entry });
      expect(readFileSync(entry, 'utf8')).toBe('// agent');
      expect(readlinkSync(current())).toBe(release);
      expect(calls).toContain('systemctl --user restart crystal.service');
    });

    onUnix('on macOS waits for the old agent to go before starting the new one', async () => {
      deployedKingdom();
      fetchHub.mockResolvedValue(quiet);
      answers['launchctl print'] = new Error('not loaded');
      await runAdopt(deps('darwin'));
      expect(calls.findIndex((call) => call.includes('launchctl bootout'))).toBeLessThan(
        calls.findIndex((call) => call.includes('launchctl print')),
      );
      expect(calls.at(-1)).toContain('launchctl bootstrap gui/501');
      expect(readFileSync(servicePath(home, 'darwin'), 'utf8')).toContain('/from/env:/usr/bin');
    });

    onUnix(
      'refuses a machine that is not a Kingdom, and Windows, which the deploy scripts never installed',
      async () => {
        await expect(runAdopt(deps())).rejects.toThrow(/not a Kingdom/);
        await expect(runAdopt(deps('win32'))).rejects.toThrow(/Linux and macOS/);
      },
    );
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

  onUnix('says why the hub could not be reached, not just that a fetch failed', async () => {
    fetchHub.mockRejectedValue(new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND hub') }));
    await expect(runJoin('https://hub.example.com', 'CODE', deps())).rejects.toThrow(
      /https:\/\/hub\.example\.com.*fetch failed: getaddrinfo ENOTFOUND hub/,
    );
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
