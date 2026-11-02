import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const workflow = readFileSync('.github/workflows/release.yml', 'utf8');

/** A job's own lines, up to the next job at the same indent. */
function job(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `no job ${name}`);
  const next = workflow.slice(start + 1).search(/\n {2}[#\w-]/);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

describe('the release workflow', () => {
  it('proves a tag before anything is published', () => {
    assert.match(job('release'), /^ {4}needs: verify$/m);
    assert.match(job('image'), /^ {4}needs: \[verify, release\]$/m);
  });

  it('holds a tag to a commit on main, with the history to tell', () => {
    const verify = job('verify');
    assert.match(verify, /fetch-depth: 0/);
    assert.match(verify, /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/);
  });

  it('runs the checks a pull request does', () => {
    const verify = job('verify');
    assert.match(verify, /run: pnpm typecheck/);
    assert.match(verify, /run: pnpm test/);
  });

  it('gives the check no way to publish', () => {
    assert.doesNotMatch(job('verify'), /permissions:|id-token|contents: write/);
  });

  // A Kingdom only trusts this workflow's attestation, so what it signs must not move.
  it('still attests the tarballs and the image', () => {
    assert.match(job('release'), /subject-path: \$\{\{ runner\.temp \}\}\/release\/\*\.tgz/);
    assert.match(job('image'), /subject-digest: \$\{\{ steps\.push\.outputs\.digest \}\}/);
  });
});
