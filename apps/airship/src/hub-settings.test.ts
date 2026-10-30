import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanHubName, loadHubSettings } from './hub-settings.js';

describe('hub settings', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'airship-settings-'));
    path = join(dir, 'hub.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('has no name until one is set, and keeps it across a restart', () => {
    expect(loadHubSettings(path).name()).toBeUndefined();
    loadHubSettings(path).setName('Home fleet');
    expect(loadHubSettings(path).name()).toBe('Home fleet');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('clears the name', () => {
    const settings = loadHubSettings(path);
    settings.setName('Home fleet');
    settings.setName(undefined);
    expect(settings.name()).toBeUndefined();
  });

  it('trims a name, and refuses one too long or with control characters', () => {
    expect(cleanHubName('  Home fleet ')).toBe('Home fleet');
    expect(cleanHubName('   ')).toBe('');
    expect(cleanHubName('x'.repeat(41))).toBeUndefined();
    expect(cleanHubName('two\nlines')).toBeUndefined();
  });
});
