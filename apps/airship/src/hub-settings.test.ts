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

  it('updates Kingdoms automatically until told otherwise', () => {
    expect(loadHubSettings(path).kingdomUpdates()).toEqual({ mode: 'auto' });
  });

  it('keeps the approved version across a restart', () => {
    loadHubSettings(path).setKingdomUpdates({ mode: 'approved', approved: '1.2.0' });
    expect(loadHubSettings(path).kingdomUpdates()).toEqual({ mode: 'approved', approved: '1.2.0' });
  });

  it('follows full releases until told to follow main, and keeps the choice', () => {
    expect(loadHubSettings(path).channel()).toBe('stable');
    loadHubSettings(path).setChannel('edge');
    expect(loadHubSettings(path).channel()).toBe('edge');
  });

  it('remembers to approve Kingdoms once it runs the version it was updated to, once', () => {
    const settings = loadHubSettings(path);
    expect(settings.takeKingdomApproval('1.2.0')).toBe(false);
    settings.setKingdomApprovalAfter('1.2.0');
    expect(loadHubSettings(path).takeKingdomApproval('1.1.0')).toBe(false);
    expect(loadHubSettings(path).takeKingdomApproval('1.2.0')).toBe(true);
    expect(loadHubSettings(path).takeKingdomApproval('1.2.0')).toBe(false);
  });

  it('keeps each setting when the other changes', () => {
    const settings = loadHubSettings(path);
    settings.setName('Home fleet');
    settings.setKingdomUpdates({ mode: 'approved', approved: '1.2.0' });
    expect(settings.name()).toBe('Home fleet');
    settings.setName('New name');
    expect(settings.kingdomUpdates()).toEqual({ mode: 'approved', approved: '1.2.0' });
    settings.setName(undefined);
    expect(settings.kingdomUpdates()).toEqual({ mode: 'approved', approved: '1.2.0' });
  });

  it('trims a name, and refuses one too long or with control characters', () => {
    expect(cleanHubName('  Home fleet ')).toBe('Home fleet');
    expect(cleanHubName('   ')).toBe('');
    expect(cleanHubName('x'.repeat(41))).toBeUndefined();
    expect(cleanHubName('two\nlines')).toBeUndefined();
  });
});
