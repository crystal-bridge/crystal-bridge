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
  it('finds the folder holding the installed package', () => {
    expect(installRootOf('/c/_npx/ab/node_modules/@crystal-bridge/kingdom/dist/main.js')).toBe('/c/_npx/ab');
  });

  it('is nothing when running from source', () => {
    expect(installRootOf('/home/me/code/crystal-bridge/apps/crystal/src/main.ts')).toBeUndefined();
  });
});

describe('join and leave', () => {
  let dir: string;
  let home: string;
  let npx: string;
  let calls: string[];
  let lines: string[];
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
  const current = () => join(home, '.local/share/crystal-bridge/current');

  it('installs a lasting copy, writes the token owner-only and starts the service on Linux', async () => {
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

  it('never prints the token or the login-s email', async () => {
    await runJoin('https://hub.example.com', 'CODE', deps());
    expect(lines.join('\n')).not.toContain('the-token');
    expect(lines.join('\n')).not.toContain('someone@example.com');
  });

  it('leaves the temporary npx folder off the PATH the service keeps', async () => {
    await runJoin('https://hub.example.com', 'CODE', deps());
    expect(readFileSync(servicePath(home, 'linux'), 'utf8')).toContain('Environment=PATH=/opt/node/bin:/usr/bin\n');
  });

  it('keeps the login shell, because a service manager may not set SHELL', async () => {
    await runJoin('https://hub.example.com', 'CODE', deps());
    expect(readFileSync(envFile(), 'utf8')).toContain('CRYSTAL_LOGIN_SHELL=/bin/zsh\n');
  });

  it('starts a launchd agent on macOS', async () => {
    await runJoin('https://hub.example.com', 'CODE', deps('darwin'));
    const plist = servicePath(home, 'darwin');
    expect(existsSync(plist)).toBe(true);
    expect(calls).toContain(`launchctl bootstrap gui/501 ${plist}`);
    expect(calls.some((call) => call.startsWith('systemctl'))).toBe(false);
  });

  it('turns lingering on when it is off, and says so', async () => {
    answers['show-user'] = 'no';
    await runJoin('https://hub.example.com', 'CODE', deps());
    expect(calls).toContain('sudo loginctl enable-linger me');
    expect(lines.join('\n')).toMatch(/linger/i);
  });

  it('still finishes when lingering cannot be turned on, with a warning', async () => {
    answers['show-user'] = 'no';
    answers['enable-linger'] = new Error('no sudo');
    await runJoin('https://hub.example.com', 'CODE', deps());
    expect(calls).toContain('systemctl --user enable --now crystal.service');
    expect(lines.join('\n')).toContain('sudo loginctl enable-linger me');
  });

  it('refuses a machine that is already a Kingdom, without spending the code', async () => {
    mkdirSync(join(home, '.config/crystal-bridge'), { recursive: true });
    writeFileSync(envFile(), 'CRYSTAL_TOKEN=old\n');
    await expect(runJoin('https://hub.example.com', 'CODE', deps())).rejects.toThrow(/already a Kingdom/);
    expect(fetchHub).not.toHaveBeenCalled();
    expect(readFileSync(envFile(), 'utf8')).toBe('CRYSTAL_TOKEN=old\n');
  });

  it('refuses a machine without the CLI, without spending the code', async () => {
    answers['--version'] = new Error('ENOENT');
    await expect(runJoin('https://hub.example.com', 'CODE', deps())).rejects.toThrow(/Claude Code/);
    expect(fetchHub).not.toHaveBeenCalled();
  });

  it('says how to sign in when the CLI is signed out, without spending the code', async () => {
    answers['auth status'] = JSON.stringify({ loggedIn: false });
    await expect(runJoin('https://hub.example.com', 'CODE', deps())).rejects.toThrow(/claude auth login/);
    expect(fetchHub).not.toHaveBeenCalled();
  });

  it('refuses Windows for now, plainly', async () => {
    await expect(runJoin('https://hub.example.com', 'CODE', deps('win32'))).rejects.toThrow(/Linux and macOS/);
  });

  it('reports a refused code and writes nothing that makes it a Kingdom', async () => {
    reply = { status: 401, body: { error: 'that code is wrong, used or expired' } };
    await expect(runJoin('https://hub.example.com', 'CODE', deps())).rejects.toThrow(/wrong, used or expired/);
    expect(existsSync(envFile())).toBe(false);
    expect(calls.some((call) => call.includes('enable --now'))).toBe(false);
  });

  it('refuses to run from source, where there is nothing lasting to copy', async () => {
    const fromSource = { ...deps(), mainPath: '/home/me/code/crystal-bridge/apps/crystal/src/main.ts' };
    await expect(runJoin('https://hub.example.com', 'CODE', fromSource)).rejects.toThrow(/installed package/);
    expect(fetchHub).not.toHaveBeenCalled();
  });

  it('leave gives up the token, stops the service and removes everything it installed', async () => {
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

  it('leave finishes even if the hub cannot be reached, and says the token is still live', async () => {
    await runJoin('https://hub.example.com', 'CODE', deps());
    fetchHub.mockRejectedValue(new Error('offline'));
    await runLeave(deps());
    expect(existsSync(envFile())).toBe(false);
    expect(lines.join('\n')).toMatch(/remove it from the app/i);
  });

  it('leave refuses a machine that is not a Kingdom', async () => {
    await expect(runLeave(deps())).rejects.toThrow(/not a Kingdom/);
  });
});
