import { execFile } from 'node:child_process';

/**
 * Sessions should see what a terminal session on the node would: Crystal runs as a systemd user service, whose
 * environment lacks what the user's shell startup files add (cargo, pyenv, bun and ~/bin on PATH, NVM_* and so on).
 * So Crystal reads the login shell's environment once at startup and starts every `claude` with it.
 */

/**
 * Set per shell (not meaningful to pass on), Crystal's own secret, which no session may see, and the variables a
 * parent `claude` sets for its session (as when Crystal itself was started from one), which would make every
 * session think it's nested. A user's own CLAUDE_CODE_* settings pass through.
 */
export const DROP = new Set([
  'PWD',
  'OLDPWD',
  'SHLVL',
  '_',
  'CRYSTAL_TOKEN',
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
]);

/** `env -0` output to a map. A noisy interactive shell may print before it; the first `=`-less chunk is skipped. */
export function parseEnv0(output: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of output.split('\0')) {
    // Text a shell printed before env -0 ends up glued to the first entry, after its last newline.
    const lineStart = /^[A-Za-z_][A-Za-z0-9_]*=/.test(entry) ? entry : entry.slice(entry.lastIndexOf('\n') + 1);
    const eq = lineStart.indexOf('=');
    if (eq <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(lineStart.slice(0, eq))) continue;
    env[lineStart.slice(0, eq)] = lineStart.slice(eq + 1);
  }
  return env;
}

/** The login shell's variables over the service's, except Crystal's own settings, which the service sets, and its token. */
export function mergeEnv(
  service: Record<string, string | undefined>,
  login: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...service, ...login })) {
    if (value === undefined || DROP.has(key)) continue;
    merged[key] = key.startsWith('CRYSTAL_') && service[key] !== undefined ? service[key]! : value;
  }
  return merged;
}

type Exec = (file: string, args: string[]) => Promise<string>;

const execText: Exec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });

/**
 * The environment of an interactive login shell (`-lic`), or nothing if the shell fails or times out. Windows has no
 * such thing, and a task started at sign-in already has the user's environment.
 */
export async function readLoginEnv(
  shell: string,
  exec: Exec = execText,
  platform: NodeJS.Platform = process.platform,
): Promise<Record<string, string>> {
  if (platform === 'win32') return {};
  try {
    return parseEnv0(await exec(shell, ['-lic', 'env -0']));
  } catch {
    return {};
  }
}
