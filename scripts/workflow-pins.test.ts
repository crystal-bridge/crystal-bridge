import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const WORKFLOWS = fileURLToPath(new URL('../.github/workflows', import.meta.url));
/** A full commit, with its version beside it, so Dependabot can keep it current and a reader can see what it is. */
const PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/;

const uses = readdirSync(WORKFLOWS).flatMap((file) =>
  readFileSync(join(WORKFLOWS, file), 'utf8')
    .split('\n')
    .flatMap((line) => /^\s*(?:- )?uses:\s*(.+?)\s*$/.exec(line)?.[1] ?? []),
);

describe('GitHub workflows', () => {
  it('finds the actions it checks', () => {
    assert.ok(uses.length > 0);
  });

  // A moved tag would run new code in CI, and the release workflow logs in to a registry and attests builds.
  it('pins every action to a commit', () => {
    assert.deepEqual(
      uses.filter((action) => !PINNED.test(action)),
      [],
    );
  });
});
