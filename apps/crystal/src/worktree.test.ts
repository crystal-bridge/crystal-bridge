import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktree, removeWorktree } from './worktree.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('createWorktree', () => {
  let dir: string;
  let repo: string;
  beforeEach(() => {
    // Real path: on macOS the temp dir is behind a symlink, and git reports resolved paths.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'crystal-worktree-')));
    repo = join(dir, 'repo');
    mkdirSync(join(repo, 'sub'), { recursive: true });
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'hello');
    git(repo, 'add', 'a.txt');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('adds a worktree on a new branch from HEAD under the repo root, even from a subfolder', async () => {
    const result = await createWorktree(join(repo, 'sub'), '0123abcd-0000-4000-8000-000000000000');
    expect(result).toEqual({ path: join(repo, '.worktrees', '0123abcd'), root: repo, branch: 'cb/0123abcd' });
    expect(readFileSync(join(result.path, 'a.txt'), 'utf8')).toBe('hello');
    expect(git(result.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('cb/0123abcd');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('keeps .worktrees out of the repo-s status through the local exclude file, once', async () => {
    await createWorktree(repo, '11111111-0000-4000-8000-000000000000');
    await createWorktree(repo, '22222222-0000-4000-8000-000000000000');
    const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.match(/^\/\.worktrees\/$/gm)).toHaveLength(1);
    expect(existsSync(join(repo, '.gitignore'))).toBe(false);
  });

  it('refuses a folder that is not in a git repository', async () => {
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    await expect(createWorktree(plain, '33333333-0000-4000-8000-000000000000')).rejects.toThrow(/not a git repository/);
  });

  it('removes a clean session worktree and keeps its branch', async () => {
    const made = await createWorktree(repo, '44444444-0000-4000-8000-000000000000');
    expect(await removeWorktree(made.path)).toEqual({ removed: true });
    expect(existsSync(made.path)).toBe(false);
    expect(git(repo, 'branch', '--list', made.branch)).toContain(made.branch);
  });

  it('keeps a worktree with uncommitted changes, and says why', async () => {
    const made = await createWorktree(repo, '55555555-0000-4000-8000-000000000000');
    writeFileSync(join(made.path, 'wip.txt'), 'unsaved');
    expect(await removeWorktree(made.path)).toEqual({ removed: false, reason: 'it has uncommitted changes' });
    expect(existsSync(join(made.path, 'wip.txt'))).toBe(true);
  });

  it('never touches a folder that is not one of its own .worktrees checkouts', async () => {
    expect(await removeWorktree(repo)).toEqual({ removed: false, reason: 'not a session worktree' });
    expect(existsSync(join(repo, 'a.txt'))).toBe(true);
  });
});
