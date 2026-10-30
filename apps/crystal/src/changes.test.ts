import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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

  it('caps a very long list', async () => {
    const { dir } = repo();
    const changes = gitChanges(dir, { maxFiles: 2 });
    await changes.begin();
    for (const name of ['a', 'b', 'c']) writeFileSync(join(dir, name), '1');
    expect(await changes.finish()).toHaveLength(2);
  });
});
