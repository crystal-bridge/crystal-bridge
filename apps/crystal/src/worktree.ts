import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Where a session's worktree went: its folder, the repository it belongs to, and its branch. */
export interface Worktree {
  path: string;
  root: string;
  branch: string;
}

function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (error, stdout, stderr) =>
      error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout.trim()),
    );
  });
}

const EXCLUDE = '/.worktrees/';

/**
 * Gives a session its own checkout so two sessions can work in one repository at once:
 * `<root>/.worktrees/<id>` on a new branch `cb/<id>` from HEAD, where id is the session id's first 8 characters.
 * `.worktrees/` goes in the repository's local exclude file (not .gitignore), so nothing in the repo changes.
 * The CLI keys its memory by the repository root, so the worktree shares the repo's memory.
 */
export async function createWorktree(cwd: string, session: string): Promise<Worktree> {
  let root: string;
  try {
    root = await git(cwd, 'rev-parse', '--show-toplevel');
  } catch {
    throw new Error(`${cwd} is not a git repository`);
  }
  const id = session.slice(0, 8);
  const path = join(root, '.worktrees', id);
  const branch = `cb/${id}`;

  const exclude = join(await git(root, 'rev-parse', '--absolute-git-dir'), 'info', 'exclude');
  const current = await readFile(exclude, 'utf8').catch(() => '');
  if (!current.split('\n').includes(EXCLUDE)) {
    await mkdir(join(exclude, '..'), { recursive: true });
    await appendFile(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}${EXCLUDE}\n`);
  }

  await git(root, 'worktree', 'add', '-q', '-b', branch, path, 'HEAD');
  return { path, root, branch };
}

/**
 * Removes a session's worktree when its session is closed. Only one of its own checkouts (a linked worktree at
 * `<root>/.worktrees/<id>`) is touched, and never with --force: uncommitted changes keep it. The `cb/<id>` branch
 * always stays, since its commits may matter.
 */
export async function removeWorktree(path: string): Promise<{ removed: true } | { removed: false; reason: string }> {
  let top: string;
  let gitDir: string;
  let commonDir: string;
  try {
    top = await git(path, 'rev-parse', '--show-toplevel');
    gitDir = await git(path, 'rev-parse', '--absolute-git-dir');
    commonDir = await git(path, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  } catch {
    return { removed: false, reason: 'not a session worktree' };
  }
  const linked = gitDir !== commonDir;
  if (!linked || top !== path || !/\/\.worktrees\/[0-9a-f]{8}$/.test(path)) {
    return { removed: false, reason: 'not a session worktree' };
  }
  if ((await git(path, 'status', '--porcelain')) !== '')
    return { removed: false, reason: 'it has uncommitted changes' };
  await git(path, 'worktree', 'remove', path);
  return { removed: true };
}
