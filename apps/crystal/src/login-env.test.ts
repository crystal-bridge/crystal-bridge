import { describe, expect, it } from 'vitest';
import { mergeEnv, parseEnv0, readLoginEnv } from './login-env.js';

describe('login environment', () => {
  it('has nothing to read on Windows, and never runs a shell there', async () => {
    const exec = () => Promise.reject(new Error('should not run'));
    expect(await readLoginEnv('cmd.exe', exec, 'win32')).toEqual({});
  });

  it('parses env -0 output, ignoring anything a noisy shell printed first', () => {
    const output =
      'Welcome to the shell!\nnvm: using node\n' +
      ['PATH=/a:/b', 'MULTI=line one\nline two', 'EMPTY='].join('\0') +
      '\0';
    expect(parseEnv0(output)).toEqual({ PATH: '/a:/b', MULTI: 'line one\nline two', EMPTY: '' });
  });

  it('layers the login shell over the service, keeps Crystal-s own settings, and drops per-shell variables and the node token', () => {
    const service = { PATH: '/usr/bin', HOME: '/home/me', CRYSTAL_NODE: 'local', CRYSTAL_TOKEN: 'secret' };
    const login = {
      PATH: '/home/me/.cargo/bin:/usr/bin',
      PYENV_ROOT: '/home/me/.pyenv',
      CRYSTAL_NODE: 'shell-value',
      PWD: '/x',
      SHLVL: '2',
      _: '/usr/bin/env',
      OLDPWD: '/y',
    };
    expect(mergeEnv(service, login)).toEqual({
      PATH: '/home/me/.cargo/bin:/usr/bin',
      HOME: '/home/me',
      PYENV_ROOT: '/home/me/.pyenv',
      CRYSTAL_NODE: 'local',
    });
  });

  it('drops a parent claude session-s variables (Crystal started from one), but keeps the user-s CLAUDE_CODE_ settings', () => {
    const merged = mergeEnv(
      { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_ENTRYPOINT: 'cli', PATH: '/bin' },
      { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000' },
    );
    expect(merged).toEqual({ PATH: '/bin', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000' });
  });

  it('reads the login shell with -lic, and falls back to nothing when the shell fails', async () => {
    const calls: string[][] = [];
    const ok = await readLoginEnv(
      '/bin/bash',
      async (file, args) => {
        calls.push([file, ...args]);
        return 'A=1\0B=2\0';
      },
      'linux',
    );
    expect(ok).toEqual({ A: '1', B: '2' });
    expect(calls).toEqual([['/bin/bash', '-lic', 'env -0']]);

    expect(
      await readLoginEnv(
        '/bin/bash',
        async () => {
          throw new Error('timed out');
        },
        'linux',
      ),
    ).toEqual({});
  });
});
