import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SCRIPT = new URL('./deploy-all.sh', import.meta.url).pathname;

function run(config: string | undefined, ...args: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'cb-deploy-all-'));
  if (config !== undefined) {
    mkdirSync(join(home, '.config', 'crystal-bridge'), { recursive: true });
    writeFileSync(join(home, '.config', 'crystal-bridge', 'deploy.env'), config);
  }
  return spawnSync('bash', [SCRIPT, '--dry-run', ...args], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
}

describe('deploy-all.sh', () => {
  it('explains what to set up when there is no config yet', () => {
    const res = run(undefined);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /deploy\.env/);
    assert.match(res.stderr, /HUB_HOST=/);
  });

  it('deploys the hub first, then each Kingdom, then this Mac when idle', () => {
    const res = run('HUB_HOST=hub-host\nKINGDOMS="node-a-host:node-a node-b-host:node-b"\nLOCAL_NODE=laptop\n');
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(res.stdout.trim().split('\n'), [
      'scripts/deploy-airship.sh hub-host',
      'scripts/deploy-crystal.sh node-a-host node-a hub-host',
      'scripts/deploy-crystal.sh node-b-host node-b hub-host',
      'scripts/deploy-crystal-macos.sh laptop hub-host --when-idle',
    ]);
  });

  it('passes --force on to the Kingdom deploys and can skip the hub', () => {
    const res = run('HUB_HOST=hub-host\nKINGDOMS="node-a-host:node-a"\n', '--force', '--kingdoms-only');
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(res.stdout.trim().split('\n'), ['scripts/deploy-crystal.sh node-a-host node-a hub-host --force']);
  });

  it('rejects a Kingdom entry that is not ssh-host:node-id', () => {
    const res = run('HUB_HOST=hub-host\nKINGDOMS="just-a-host"\n');
    assert.equal(res.status, 2);
    assert.match(res.stderr, /ssh-host:node-id/);
  });
});
