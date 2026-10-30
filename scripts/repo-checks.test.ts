import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkCommitMessage, checkFile, isAuthorAllowed } from './repo-checks.js';

// Built from parts, so this file doesn't trip the very scrub it tests.
const email = (user: string) => `${user}@${['personal', 'dev'].join('.')}`;
const model = (...parts: string[]) => ['claude', ...parts].join('-');
const home = (root: string) => `/${root}/${'some'}body/code`;

describe('checkFile', () => {
  it('passes ordinary code', () => {
    assert.deepEqual(checkFile('src/a.ts', 'const a = 1; // see https://example.com\n', []), []);
  });

  it('flags model ids, but not the CLI or the placeholder', () => {
    assert.equal(checkFile('a.md', `runs on ${model('opus', '4', '1')} today`, []).length, 1);
    assert.deepEqual(checkFile('a.md', 'the claude-code CLI and claude-model placeholder', []), []);
  });

  it('flags home paths other than the test placeholder', () => {
    assert.equal(checkFile('a.ts', `const p = '${home('Users')}';`, []).length, 1);
    assert.equal(checkFile('a.ts', `const p = '${home('home')}';`, []).length, 1);
    assert.deepEqual(checkFile('a.ts', "const p = '/home/me/code';", []), []);
  });

  it('flags email addresses except noreply and example ones', () => {
    assert.equal(checkFile('a.md', `mail ${email('someone')}`, []).length, 1);
    assert.deepEqual(checkFile('a.md', 'x@users.noreply.github.com, noreply@example.org, user@example.com', []), []);
  });

  it('flags anything on the private deny list, case-insensitively, without echoing it', () => {
    const problems = checkFile('a.md', 'deployed to My-Secret-Host last night', ['my-secret-host']);
    assert.equal(problems.length, 1);
    assert.ok(!problems[0]!.includes('my-secret-host'));
  });

  it('skips third-party and generated files', () => {
    assert.deepEqual(checkFile('THIRD_PARTY_NOTICES.md', email('author'), []), []);
    assert.deepEqual(checkFile('pnpm-lock.yaml', email('author'), []), []);
  });
});

describe('checkCommitMessage', () => {
  it('accepts a conventional message', () => {
    assert.deepEqual(checkCommitMessage('feat(web): a thing\n\nBody.\n'), []);
    assert.deepEqual(checkCommitMessage('fix: another'), []);
  });

  it('rejects a free-form subject', () => {
    assert.equal(checkCommitMessage('Fixed stuff').length, 1);
  });

  it('rejects attribution trailers and model names', () => {
    assert.equal(checkCommitMessage('feat: x\n\nCo-Authored-By: Someone <a@b.c>').length, 1);
    assert.equal(checkCommitMessage(`feat: tuned for ${model('sonnet', '4')}`).length, 1);
  });

  it('lets git-generated messages through', () => {
    assert.deepEqual(checkCommitMessage("Merge branch 'main' into feat/x"), []);
    assert.deepEqual(checkCommitMessage('fixup! feat: x'), []);
  });
});

describe('isAuthorAllowed', () => {
  it('allows only a noreply author', () => {
    assert.ok(isAuthorAllowed('someone <123+someone@users.noreply.github.com> 1700000000 +0000'));
    assert.ok(!isAuthorAllowed(`Some One <${email('someone')}> 1700000000 +0000`));
  });
});
