import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

describe('the hub container image', () => {
  const dockerfile = existsSync('Dockerfile') ? readFileSync('Dockerfile', 'utf8') : '';

  it('defaults to the only login that is safe when reachable', () => {
    assert.match(dockerfile, /AIRSHIP_AUTH=token/);
    assert.match(dockerfile, /AIRSHIP_HOST=0\.0\.0\.0/);
  });

  it('does not run as root, and keeps its data in one volume', () => {
    assert.match(dockerfile, /^USER node$/m);
    assert.match(dockerfile, /AIRSHIP_DATA=\/data/);
    assert.match(dockerfile, /^VOLUME \/data$/m);
  });

  it('never bakes in private files', () => {
    const ignore = existsSync('.dockerignore') ? readFileSync('.dockerignore', 'utf8') : '';
    for (const path of ['.git', '.private', '**/*.db', '**/node_modules']) {
      assert.ok(ignore.split('\n').includes(path), `.dockerignore should list ${path}`);
    }
  });
});
