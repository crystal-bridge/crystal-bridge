import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SCRIPT = new URL('./publish-snapshot.sh', import.meta.url).pathname;

function git(cwd: string, ...args: string[]) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
}

/** A source repo with two commits, the first by a personal identity, and a noreply identity in its local config. */
function source() {
  const dir = mkdtempSync(join(tmpdir(), 'cb-snapshot-src-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'someone');
  git(dir, 'config', 'user.email', 'someone@users.noreply.github.com');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(dir, '-c', 'user.email=personal@example.com', 'add', '-A');
  git(dir, '-c', 'user.email=personal@example.com', 'commit', '-qm', 'first');
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'b.txt'), 'two\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'second');
  return dir;
}

function run(cwd: string, ...args: string[]) {
  return spawnSync('bash', [SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

describe('publish-snapshot.sh', () => {
  it('builds a one-commit repository of the tree under the repo-local identity', () => {
    const src = source();
    const out = join(mkdtempSync(join(tmpdir(), 'cb-snapshot-out-')), 'snap');
    const res = run(src, out, 'main');
    assert.equal(res.status, 0, res.stderr);
    assert.equal(git(out, 'rev-list', '--count', 'HEAD'), '1');
    assert.equal(
      git(out, 'log', '-1', '--format=%an <%ae>|%cn <%ce>'),
      'someone <someone@users.noreply.github.com>|someone <someone@users.noreply.github.com>',
    );
    assert.equal(git(out, 'ls-files'), 'a.txt\nsub/b.txt');
    assert.equal(readFileSync(join(out, 'sub', 'b.txt'), 'utf8'), 'two\n');
    assert.equal(git(out, 'branch', '--show-current'), 'main');
    assert.equal(git(out, 'log', '--all', '--format=%s'), 'Crystal Bridge: first public release');
    assert.doesNotMatch(git(out, 'log', '--all', '--format=%an%ae%cn%ce'), /personal@example\.com/);
  });

  it('refuses an output folder that already has something in it', () => {
    const src = source();
    const out = mkdtempSync(join(tmpdir(), 'cb-snapshot-out-'));
    writeFileSync(join(out, 'x'), '');
    const res = run(src, out, 'main');
    assert.equal(res.status, 2);
    assert.match(res.stderr, /not empty/);
  });

  it('explains its usage without an output folder', () => {
    const res = run(source());
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage/);
  });
});
