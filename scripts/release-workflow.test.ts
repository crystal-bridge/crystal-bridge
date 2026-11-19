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

  it('runs on a tag, pushed by hand or dispatched by Publish, and only on one', () => {
    assert.match(workflow, /^ {2}workflow_dispatch:/m);
    assert.match(job('verify'), /\[\[ \$GITHUB_REF == refs\/tags\/v\* \]\]/);
  });

  it('holds a full release to the package version, and stamps an edge build-s version into both packages', () => {
    const release = job('release');
    assert.match(release, /\*-edge\.\*/);
    assert.match(release, /npm pkg set version=/);
    assert.match(release, /require\('\.\/apps\/crystal\/package\.json'\)\.version/);
  });

  it('builds images for full releases only', () => {
    assert.match(job('image'), /if: \$\{\{ !contains\(github\.ref_name, '-edge\.'\) \}\}/);
  });

  it('keeps the ten newest edge releases, and only edge ones', () => {
    const prune = job('prune');
    assert.match(prune, /needs: release/);
    assert.match(prune, /-edge\./);
    assert.match(prune, /KEEP: 10/);
    assert.match(prune, /--cleanup-tag/);
  });
});

describe('the publish workflow', () => {
  const publish = readFileSync('.github/workflows/publish.yml', 'utf8');

  it('runs on each merge to main, one at a time', () => {
    assert.match(publish, /push:\n {4}branches: \[main\]/);
    assert.match(publish, /concurrency:\n {2}group: publish\n {2}cancel-in-progress: false/);
  });

  it('tags the merge as next-release.mjs says, then has Release build that tag', () => {
    assert.match(publish, /node scripts\/next-release\.mjs >> "\$GITHUB_OUTPUT"/);
    assert.match(publish, /git push origin "refs\/tags\/\$TAG"/);
    assert.match(publish, /gh workflow run release\.yml --ref "\$TAG"/);
  });

  it('may tag and dispatch, nothing more', () => {
    assert.match(publish, /contents: write/);
    assert.match(publish, /actions: write/);
    assert.doesNotMatch(publish, /id-token|packages: write|attestations/);
  });
});
