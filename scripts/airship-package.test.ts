import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

  it('backs up with the package, and still mirrors off the box', () => {
    const text = unit('deploy/airship/airship-backup.service');
    assert.match(text, /^ExecStart=.*\/crystal-bridge-airship backup$/m);
    assert.match(text, /^ExecStartPost=\/opt\/crystal-bridge\/current\/push-backups\.sh$/m);
    assert.doesNotMatch(text, /tsx|apps\/airship|deploy\/airship/);
  });
});
