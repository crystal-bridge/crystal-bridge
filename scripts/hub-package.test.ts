import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const manifest = JSON.parse(readFileSync('apps/airship/package.json', 'utf8')) as {
  name: string;
  private?: boolean;
  bin: Record<string, string>;
  files: string[];
  engines: { node: string };
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

describe('the hub package', () => {
  it('ships only the build, with a command to run', () => {
    assert.equal(manifest.name, '@crystal-bridge/airship');
    assert.equal(manifest.private, undefined);
    assert.deepEqual(manifest.files, ['dist']);
    assert.equal(manifest.bin['crystal-bridge-airship'], 'dist/main.js');
    assert.equal(manifest.engines.node, '>=22');
  });

  it('needs nothing from the workspace at runtime', () => {
    const workspace = Object.entries(manifest.dependencies).filter(([, range]) => range.startsWith('workspace:'));
    assert.deepEqual(workspace, []);
    assert.equal(manifest.devDependencies['@crystal-bridge/protocol'], 'workspace:*');
  });
});
