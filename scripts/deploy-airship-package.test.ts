import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const script = readFileSync('scripts/deploy-airship-package.sh', 'utf8');
/** The part that runs on the hub host. */
const remote = /<<'REMOTE'\n([\s\S]*?)\nREMOTE\n/.exec(script)?.[1] ?? '';

describe('the hub host side of deploy-airship-package.sh', () => {
  let root: string;
  let stage: string;
  const opt = () => join(root, 'opt/crystal-bridge');
  const live = () => join(opt(), 'releases/1.0.0');

  function tool(name: string, body: string): void {
    const file = join(root, 'bin', name);
    writeFileSync(file, `#!/bin/bash\n${body}\n`);
    chmodSync(file, 0o755);
  }

  /** npm installing a hub that says it's the version in `npm-version`, or failing when there is none. */
  function npmInstalls(version: string | undefined): void {
    tool(
      'npm',
      version
        ? `mkdir -p node_modules/.bin
           printf '#!/bin/bash\\necho ${version}\\n' > node_modules/.bin/crystal-bridge-airship
           chmod +x node_modules/.bin/crystal-bridge-airship`
        : 'exit 1',
    );
  }

  function deploy(version: string): { status: number | null; output: string } {
    const body = remote
      .replaceAll('/opt/crystal-bridge', opt())
      .replaceAll('/etc/systemd/system', join(root, 'units'))
      .replaceAll('/etc/crystal-bridge', join(root, 'etc'));
    const result = spawnSync('bash', ['-s', '--', version, stage, 'hub.tgz'], {
      input: body,
      encoding: 'utf8',
      env: { PATH: `${join(root, 'bin')}:/usr/bin:/bin`, HEALTH_VERSION: version },
    });
    return { status: result.status, output: result.stdout + result.stderr };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cb-deploy-'));
    stage = join(root, 'stage');
    mkdirSync(join(root, 'bin'));
    mkdirSync(join(root, 'units'));
    mkdirSync(join(root, 'etc'));
    mkdirSync(live(), { recursive: true });
    mkdirSync(stage);
    writeFileSync(join(live(), 'running'), 'the live hub');
    symlinkSync(live(), join(opt(), 'current'));
    writeFileSync(join(root, 'etc/airship.env'), 'AIRSHIP_PORT=7700\n');
    for (const file of ['airship.service', 'airship-backup.service', 'airship-backup.timer', 'push-backups.sh']) {
      writeFileSync(join(stage, file), '');
    }
    for (const file of ['airship.service', 'airship-backup.service']) writeFileSync(join(root, 'units', file), '');
    tool('sudo', 'if [[ $1 == -u ]]; then shift 2; fi\nexec "$@"');
    tool('systemctl', 'exit 0');
    tool('journalctl', 'exit 0');
    tool('curl', 'echo "{\\"release\\":\\"$HEALTH_VERSION\\"}"');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('finds the remote part', () => {
    assert.match(remote, /npm install/);
  });

  it('refuses the version that is live, which it used to delete before reinstalling', () => {
    npmInstalls(undefined);
    const { status, output } = deploy('1.0.0');
    assert.notEqual(status, 0);
    assert.match(output, /1\.0\.0 is already live/);
    assert.equal(readFileSync(join(live(), 'running'), 'utf8'), 'the live hub');
  });

  it('leaves nothing behind and the hub alone when an install fails', () => {
    npmInstalls(undefined);
    assert.notEqual(deploy('1.1.0').status, 0);
    assert.deepEqual(readdirSync(join(opt(), 'releases'), { withFileTypes: false }), ['1.0.0']);
    assert.equal(readlinkSync(join(opt(), 'current')), live());
  });

  it('keeps a release it goes back to when reinstalling that one fails', () => {
    const kept = join(opt(), 'releases/0.9.0');
    mkdirSync(kept);
    writeFileSync(join(kept, 'kept'), '');
    npmInstalls(undefined);
    assert.notEqual(deploy('0.9.0').status, 0);
    assert.ok(existsSync(join(kept, 'kept')));
  });

  it('puts a new release in place and goes live on it', () => {
    npmInstalls('1.1.0');
    const { status, output } = deploy('1.1.0');
    assert.equal(status, 0, output);
    assert.equal(readlinkSync(join(opt(), 'current')), join(opt(), 'releases/1.1.0'));
    assert.ok(existsSync(join(opt(), 'releases/1.1.0/push-backups.sh')));
    assert.ok(existsSync(join(opt(), 'releases/1.1.0/package.json')));
  });

  it('replaces a release it goes back to', () => {
    const kept = join(opt(), 'releases/0.9.0');
    mkdirSync(kept);
    writeFileSync(join(kept, 'stale'), '');
    npmInstalls('0.9.0');
    assert.equal(deploy('0.9.0').status, 0);
    assert.equal(readlinkSync(join(opt(), 'current')), kept);
    assert.ok(!existsSync(join(kept, 'stale')));
  });
});
