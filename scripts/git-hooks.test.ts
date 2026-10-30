import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const hooks = (JSON.parse(readFileSync('package.json', 'utf8')) as { 'simple-git-hooks': Record<string, string> })[
  'simple-git-hooks'
];

describe('the pre-push hook', () => {
  // Git exports these to hooks in a linked worktree, and a test's `git init` in a temp folder would then act on the
  // real repository: it once set core.bare on the shared config.
  it('runs the tests without the variables that point git at the real repository', () => {
    const hook = hooks['pre-push']!;
    assert.match(hook, /^env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE /);
    assert.match(hook, /pnpm typecheck && pnpm test/);
  });
});
