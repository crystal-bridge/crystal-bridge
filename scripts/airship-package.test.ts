import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const unit = (file: string): string =>
  execFileSync('bash', ['-c', 'source scripts/lib/airship-package.sh && cb_package_unit "$1"', 'unit', file], {
    encoding: 'utf8',
  });

describe('the units of a packaged hub', () => {
  it('runs the package, from the data directory, with the same hardening', () => {
    const text = unit('deploy/airship/airship.service');
    assert.match(text, /^ExecStart=\/opt\/crystal-bridge\/current\/node_modules\/\.bin\/crystal-bridge-airship$/m);
    assert.match(text, /^WorkingDirectory=\/var\/lib\/airship$/m);
    assert.match(text, /^ProtectSystem=strict$/m);
    assert.doesNotMatch(text, /tsx|apps\/airship/);
  });

  it('tells the hub where to ask its updater for a release, once, and only the hub', () => {
    const text = unit('deploy/airship/airship.service');
    assert.equal(
      text.match(/^Environment=AIRSHIP_UPDATE_REQUEST=\/var\/lib\/airship\/update-request\.json$/gm)?.length,
      1,
    );
    assert.doesNotMatch(unit('deploy/airship/airship-backup.service'), /AIRSHIP_UPDATE_REQUEST/);
  });

  it('has an updater that runs the package as root, writing only the releases and its status', () => {
    const service = readFileSync('deploy/airship/airship-update.service', 'utf8');
    assert.match(
      service,
      /^ExecStart=\/opt\/crystal-bridge\/current\/node_modules\/\.bin\/crystal-bridge-airship apply-update$/m,
    );
    assert.match(service, /^Environment=AIRSHIP_UPDATE_REQUEST=\/var\/lib\/airship\/update-request\.json$/m);
    assert.match(service, /^Type=oneshot$/m);
    assert.match(service, /^ProtectSystem=strict$/m);
    assert.match(service, /^ReadWritePaths=\/opt\/crystal-bridge \/var\/lib\/airship$/m);
    assert.doesNotMatch(service, /^User=/m);
    const path = readFileSync('deploy/airship/airship-update.path', 'utf8');
    assert.match(path, /^PathChanged=\/var\/lib\/airship\/update-request\.json$/m);
    assert.match(path, /^Unit=airship-update\.service$/m);
  });

  it('backs up with the package, and still mirrors off the box', () => {
    const text = unit('deploy/airship/airship-backup.service');
    assert.match(text, /^ExecStart=.*\/crystal-bridge-airship backup$/m);
    assert.match(text, /^ExecStartPost=\/opt\/crystal-bridge\/current\/push-backups\.sh$/m);
    assert.doesNotMatch(text, /tsx|apps\/airship|deploy\/airship/);
  });
});
