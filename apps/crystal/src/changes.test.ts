import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gitChanges } from './changes.js';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'cb-changes-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: dir });
  git('init', '-q');
  writeFileSync(join(dir, 'kept.ts'), '1');
  writeFileSync(join(dir, 'gone.ts'), '1');
  git('add', '.');
  git('commit', '-qm', 'one');
  return { dir, git };
}

describe('gitChanges', () => {
  it('keeps the next turn-s start when it begins as the last one finishes', async () => {
    const { dir } = repo();
    const changes = gitChanges(dir);
    await changes.begin();
    const finished = changes.finish();
    const begun = changes.begin();
    await Promise.all([finished, begun]);
    writeFileSync(join(dir, 'kept.ts'), '2');
    expect(await changes.finish()).toEqual(['kept.ts']);
  });

  it('sees edits from any tool: committed, uncommitted, new and deleted', async () => {
    const { dir, git } = repo();
    const changes = gitChanges(dir);
    await changes.begin();
    writeFileSync(join(dir, 'kept.ts'), '2');
    git('commit', '-qam', 'two');
    writeFileSync(join(dir, 'new.ts'), '1');
    rmSync(join(dir, 'gone.ts'));
    expect(await changes.finish()).toEqual(['gone.ts', 'kept.ts', 'new.ts']);
  });

  it('leaves out what was already changed when the turn began, and ignored files', async () => {
    const { dir, git } = repo();
    writeFileSync(join(dir, '.gitignore'), 'out/\n');
    git('add', '.gitignore');
    git('commit', '-qm', 'ignore');
    writeFileSync(join(dir, 'kept.ts'), 'mine');
    const changes = gitChanges(dir);
    await changes.begin();
    mkdirSync(join(dir, 'out'));
    writeFileSync(join(dir, 'out', 'x.js'), '1');
    writeFileSync(join(dir, 'new.ts'), '1');
    expect(await changes.finish()).toEqual(['new.ts']);
  });

  it('counts everything in a repository with no commits yet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-changes-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const changes = gitChanges(dir);
    await changes.begin();
    writeFileSync(join(dir, 'first.ts'), '1');
    expect(await changes.finish()).toEqual(['first.ts']);
  });

  it('names files relative to a Quest in a subfolder', async () => {
    const { dir, git } = repo();
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'a.ts'), '1');
    git('add', '.');
    git('commit', '-qm', 'sub');
    const changes = gitChanges(join(dir, 'sub'));
    await changes.begin();
    writeFileSync(join(dir, 'sub', 'a.ts'), '2');
    expect(await changes.finish()).toEqual(['a.ts']);
  });

  it('reports nothing for a folder that is not a repository, or a turn it never saw begin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-changes-'));
    const changes = gitChanges(dir);
    expect(await changes.finish()).toBeUndefined();
    await changes.begin();
    expect(await changes.finish()).toBeUndefined();
  });

  describe('a repository’s own config', () => {
    /** Config that runs a command of the Quest's choosing, which writes down the token it can see. */
    function fsmonitor(dir: string) {
      const seen = join(dir, '..', `${basename(dir)}-seen`);
      const script = join(dir, '.git', 'monitor.sh');
      writeFileSync(script, `#!/bin/sh\nprintf '%s' "$CRYSTAL_TOKEN" >> '${seen}'\n`);
      chmodSync(script, 0o755);
      execFileSync('git', ['config', 'core.fsmonitor', script], { cwd: dir });
      return seen;
    }
    afterEach(() => void vi.unstubAllEnvs());

    it('shows git no token, and runs no fsmonitor', async () => {
      vi.stubEnv('CRYSTAL_TOKEN', 'secret');
      const { dir } = repo();
      const seen = fsmonitor(dir);
      const { CRYSTAL_TOKEN: _token, ...env } = process.env;
      const changes = gitChanges(dir, { env });
      await changes.begin();
      writeFileSync(join(dir, 'new.ts'), '1');
      expect(await changes.finish()).toEqual(['new.ts']);
      expect(existsSync(seen)).toBe(false);
    });

    it('runs none however it was called', async () => {
      vi.stubEnv('CRYSTAL_TOKEN', 'secret');
      const { dir } = repo();
      const seen = fsmonitor(dir);
      const changes = gitChanges(dir);
      await changes.begin();
      await changes.finish();
      expect(existsSync(seen)).toBe(false);
    });
  });

  it('caps a very long list', async () => {
    const { dir } = repo();
    const changes = gitChanges(dir, { maxFiles: 2 });
    await changes.begin();
    for (const name of ['a', 'b', 'c']) writeFileSync(join(dir, name), '1');
    expect(await changes.finish()).toHaveLength(2);
  });
});
