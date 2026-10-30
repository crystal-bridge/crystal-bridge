import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { KINGDOM_PACKAGE } from '../packages/protocol/src/index.js';

const manifest = JSON.parse(readFileSync('apps/crystal/package.json', 'utf8')) as {
  name: string;
  private?: boolean;
  version: string;
  bin: Record<string, string>;
  files: string[];
  engines: { node: string };
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

describe('the Kingdom package', () => {
  it('uses the word users see, and ships only the build', () => {
    assert.equal(manifest.name, '@crystal-bridge/kingdom');
    assert.equal(manifest.private, undefined);
    assert.deepEqual(manifest.files, ['dist']);
    assert.equal(manifest.bin['crystal-bridge-kingdom'], 'dist/main.js');
  });

  it('has a real version', () => {
    assert.notEqual(manifest.version, '0.0.0');
  });

  it('needs nothing from the workspace at runtime', () => {
    const workspace = Object.entries(manifest.dependencies).filter(([, range]) => range.startsWith('workspace:'));
    assert.deepEqual(workspace, []);
    assert.equal(manifest.devDependencies['@crystal-bridge/protocol'], 'workspace:*');
  });

  it('is what Add Kingdom installs, so the command never points at an older or missing release', () => {
    assert.ok(KINGDOM_PACKAGE.endsWith(`/v${manifest.version}/crystal-bridge-kingdom-${manifest.version}.tgz`));
  });

  it('states the Node version it runs on', () => {
    assert.equal(manifest.engines.node, '>=22');
  });
});
