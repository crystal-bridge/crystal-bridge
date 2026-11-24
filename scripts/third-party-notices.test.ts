import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { render } from './third-party-notices.js';

/** A package folder holding `files`, removed after `use`. */
function withPackage<T>(files: Record<string, string>, use: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'cb-notices-'));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const entry = (name: string, license: string, dir: string) => ({ name, versions: ['1.0.0'], paths: [dir], license });

describe('THIRD_PARTY_NOTICES.md', () => {
  it("names a package's licence from its licence file when its package.json has none", () => {
    const notices = withPackage({ license: 'The MIT License (MIT)\n\nCopyright (c) someone\n' }, (dir) =>
      render({ x: [entry('khroma', 'Unknown', dir)] }),
    );
    assert.match(notices, /^- khroma 1\.0\.0: MIT$/m);
    assert.match(notices, /^\| MIT \| 1 \|$/m);
    assert.doesNotMatch(notices, /Unknown/);
  });

  it('says which licence a dual-licensed package is used under, and where EPL-2.0 source is', () => {
    const notices = withPackage(
      {
        'package.json': JSON.stringify({ repository: { type: 'git', url: 'git+https://github.com/kieler/elkjs.git' } }),
        'LICENSE.md': '# Eclipse Public License - v 2.0\n',
      },
      (dir) => render({ x: [entry('elkjs', 'EPL-2.0 OR GPL-3.0-or-later', dir)] }),
    );
    assert.match(
      notices,
      /^- elkjs 1\.0\.0: EPL-2.0 OR GPL-3\.0-or-later, used under EPL-2\.0; source: https:\/\/github\.com\/kieler\/elkjs$/m,
    );
    assert.match(notices, /^\| EPL-2\.0 \| 1 \|$/m);
  });

  it('refuses a choice of licences nobody has chosen from yet', () => {
    withPackage({}, (dir) =>
      assert.throws(() => render({ x: [entry('newcomer', 'MIT OR Apache-2.0', dir)] }), /newcomer.*MIT OR Apache-2\.0/),
    );
  });
});
