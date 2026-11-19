import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nextRelease } from './next-release.mjs';

describe('nextRelease: what a merge to main publishes', () => {
  it('publishes a version a release PR raised, as a full release', () => {
    assert.deepEqual(nextRelease('0.7.0', ['v0.6.0', 'v0.5.1']), {
      version: '0.7.0',
      tag: 'v0.7.0',
      channel: 'stable',
    });
  });

  it('else publishes an edge build of the next patch, numbered after the last one', () => {
    assert.deepEqual(nextRelease('0.6.0', ['v0.6.0', 'v0.5.1']), {
      version: '0.6.1-edge.1',
      tag: 'v0.6.1-edge.1',
      channel: 'edge',
    });
    assert.equal(
      nextRelease('0.6.0', ['v0.6.0', 'v0.6.1-edge.1', 'v0.6.1-edge.9', 'v0.6.1-edge.10']).version,
      '0.6.1-edge.11',
    );
  });

  it('numbers from the newest full release, not a stale package version or another line-s builds', () => {
    assert.equal(nextRelease('0.5.0', ['v0.6.0', 'v0.6.1-edge.3']).version, '0.6.1-edge.4');
    assert.equal(nextRelease('0.6.0', ['v0.6.0', 'v0.5.2-edge.8']).version, '0.6.1-edge.1');
  });

  it('starts again after a release, so an edge build always sorts after the release before it', () => {
    assert.equal(nextRelease('0.7.0', ['v0.7.0', 'v0.6.0', 'v0.6.1-edge.40']).version, '0.7.1-edge.1');
  });

  it('starts from the package version when nothing is tagged yet', () => {
    assert.deepEqual(nextRelease('0.1.0', []), { version: '0.1.0', tag: 'v0.1.0', channel: 'stable' });
  });

  it('ignores tags that are not releases, and refuses a package version that is not one', () => {
    assert.equal(nextRelease('0.6.0', ['v0.6.0', 'vnext', 'v0.6.1-rc.1', 'docs-1']).version, '0.6.1-edge.1');
    assert.throws(() => nextRelease('0.6', ['v0.6.0']), /not a release version/);
  });
});
