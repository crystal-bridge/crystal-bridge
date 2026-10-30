import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * There is no one config schema, so docs/CONFIGURATION.md is written by hand and this holds it to the code: every
 * CRYSTAL_ or AIRSHIP_ name in apps/ or packages/, outside tests, needs a row. It looks for the name anywhere rather
 * than for `process.env`, because the code reads them several ways (`env.X`, a helper taking 'X', a list of names).
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REFERENCE = join(ROOT, 'docs', 'CONFIGURATION.md');
const NAME = /\b(?:CRYSTAL|AIRSHIP)_[A-Z0-9_]*[A-Z0-9]\b/g;
/** A name put together at runtime, which NAME can't see. */
const BUILT_NAME = /(?:CRYSTAL|AIRSHIP)_\$\{|['"`](?:CRYSTAL|AIRSHIP)_['"`]\s*\+/;
/** Spelled like a variable but not one: the Crystal theme's step words in apps/web/src/theme/words.ts. */
const NOT_VARIABLES = new Set(['CRYSTAL_STEPS']);
const TESTS = /(^|\/)(test|__fixtures__)\/|\.test\.tsx?$/;

function sources(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', 'apps', 'packages'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => path !== '' && !TESTS.test(path) && existsSync(join(ROOT, path)));
}

function envNames(text: string): string[] {
  return [...new Set(text.match(NAME) ?? [])].filter((name) => !NOT_VARIABLES.has(name)).sort();
}

function listedNames(table: string): Set<string> {
  return new Set([...table.matchAll(/^\| `([A-Z0-9_]+)` \|/gm)].map((match) => match[1]!));
}

describe('envNames', () => {
  it('finds a name however the code reads it', () => {
    const code = `
      process.env.CRYSTAL_ONE;
      process.env['AIRSHIP_TWO'];
      envValue(env, 'CRYSTAL_THREE');
      const { AIRSHIP_FOUR } = process.env;
    `;
    assert.deepEqual(envNames(code), ['AIRSHIP_FOUR', 'AIRSHIP_TWO', 'CRYSTAL_ONE', 'CRYSTAL_THREE']);
  });

  it('leaves out prefixes, build constants and the theme constant', () => {
    assert.deepEqual(envNames(`key.startsWith('CRYSTAL_'); __AIRSHIP_VERSION__; CRYSTAL_STEPS`), []);
  });
});

describe('listedNames', () => {
  it('reads the first cell of each row', () => {
    assert.deepEqual([...listedNames('| Variable | Default |\n|---|---|\n| `CRYSTAL_HUB` | a |\n')], ['CRYSTAL_HUB']);
  });
});

describe('docs/CONFIGURATION.md', () => {
  const files = sources();

  it('finds the source files and leaves the tests out', () => {
    assert.ok(files.includes('apps/crystal/src/main.ts'));
    assert.ok(files.includes('apps/airship/src/paths.ts'));
    assert.ok(!files.some((path) => TESTS.test(path)));
  });

  it('lists every variable the code reads', () => {
    const listed = listedNames(readFileSync(REFERENCE, 'utf8'));
    const missing = files.flatMap((path) =>
      envNames(readFileSync(join(ROOT, path), 'utf8'))
        .filter((name) => !listed.has(name))
        .map((name) => `${name} (${path})`),
    );
    assert.deepEqual(missing, [], 'add these to docs/CONFIGURATION.md');
  });

  it('can see every name: none is put together at runtime', () => {
    const built = files.filter((path) => BUILT_NAME.test(readFileSync(join(ROOT, path), 'utf8')));
    assert.deepEqual(built, [], 'read these with a literal name, so the reference can be checked');
  });
});
