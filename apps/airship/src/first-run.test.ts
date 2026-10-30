import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFirstRun } from './first-run.js';
import { loadNodes, type NodeRegistry } from './nodes.js';

describe('first run', () => {
  let dir: string;
  let tokens: NodeRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'airship-first-run-'));
    tokens = loadNodes(join(dir, 'access-tokens.json'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is pending on a hub with no logins, and a good code makes the first one', () => {
    const firstRun = createFirstRun(tokens);
    expect(firstRun.pending()).toBe(true);
    const token = firstRun.claim(firstRun.code, 'me');
    expect(tokens.verify(token)).toBe('me');
    expect(firstRun.pending()).toBe(false);
  });

  it('refuses a wrong code and stays pending, so a guess cannot burn the real one', () => {
    const firstRun = createFirstRun(tokens);
    expect(firstRun.claim('wrong', 'me')).toBeUndefined();
    expect(firstRun.claim('', 'me')).toBeUndefined();
    expect(tokens.ids()).toEqual([]);
    expect(firstRun.pending()).toBe(true);
  });

  it('works once', () => {
    const firstRun = createFirstRun(tokens);
    firstRun.claim(firstRun.code, 'me');
    expect(firstRun.claim(firstRun.code, 'them')).toBeUndefined();
    expect(tokens.ids()).toEqual(['me']);
  });

  it('stops being pending once a login arrives another way, and the code then does nothing', () => {
    const firstRun = createFirstRun(tokens);
    tokens.issue('from-the-cli');
    expect(firstRun.pending()).toBe(false);
    expect(firstRun.claim(firstRun.code, 'me')).toBeUndefined();
    expect(tokens.ids()).toEqual(['from-the-cli']);
  });

  it('stays closed after a used code even if every login is later removed', () => {
    const firstRun = createFirstRun(tokens);
    firstRun.claim(firstRun.code, 'me');
    tokens.revoke('me');
    expect(firstRun.pending()).toBe(false);
    expect(firstRun.claim(firstRun.code, 'me')).toBeUndefined();
  });

  it('makes a different code each time', () => {
    expect(createFirstRun(tokens).code).not.toBe(createFirstRun(tokens).code);
  });
});
