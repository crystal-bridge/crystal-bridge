import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addNode, loadNodes } from './nodes.js';

describe('node tokens', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'airship-nodes-'));
    file = join(dir, 'nodes.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('issues a token that verifies as its node, and stores only a hash of it', () => {
    const token = addNode(file, 'node-b');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readFileSync(file, 'utf8')).not.toContain(token);
    expect(loadNodes(file).verify(token)).toBe('node-b');
  });

  it('rejects unknown, empty and missing tokens', () => {
    addNode(file, 'node-b');
    const nodes = loadNodes(file);
    expect(nodes.verify('nope')).toBeUndefined();
    expect(nodes.verify('')).toBeUndefined();
    expect(nodes.verify(undefined)).toBeUndefined();
  });

  it('keeps nodes apart, and re-adding a node rotates its token', () => {
    const first = addNode(file, 'node-b');
    const other = addNode(file, 'node-a');
    const rotated = addNode(file, 'node-b');
    const nodes = loadNodes(file);
    expect(nodes.verify(first)).toBeUndefined();
    expect(nodes.verify(rotated)).toBe('node-b');
    expect(nodes.verify(other)).toBe('node-a');
    expect(nodes.ids()).toEqual(['node-a', 'node-b']);
  });

  it('sees a token issued after it was loaded, without a restart', () => {
    const nodes = loadNodes(file);
    expect(nodes.ids()).toEqual([]);
    const token = addNode(file, 'node-b');
    expect(nodes.verify(token)).toBe('node-b');
    expect(nodes.ids()).toEqual(['node-b']);
  });

  it('revokes a node at once, for good, and leaves the others', () => {
    const token = addNode(file, 'node-b');
    const other = addNode(file, 'node-a');
    const nodes = loadNodes(file);
    expect(nodes.revoke('node-b')).toBe(true);
    expect(nodes.verify(token)).toBeUndefined();
    expect(loadNodes(file).verify(token)).toBeUndefined();
    expect(nodes.verify(other)).toBe('node-a');
    expect(nodes.ids()).toEqual(['node-a']);
  });

  it('reports revoking a node it does not know', () => {
    addNode(file, 'node-b');
    const nodes = loadNodes(file);
    expect(nodes.revoke('node-a')).toBe(false);
    expect(nodes.revoke('__proto__')).toBe(false);
    expect(nodes.ids()).toEqual(['node-b']);
  });

  it('keeps the file owner-only and leaves nothing else beside it after a revoke', () => {
    addNode(file, 'node-b');
    addNode(file, 'node-a');
    loadNodes(file).revoke('node-b');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['nodes.json']);
  });

  it('writes the file readable by its owner only', () => {
    addNode(file, 'node-b');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('refuses a node id that is empty or has unusual characters', () => {
    expect(() => addNode(file, '')).toThrow();
    expect(() => addNode(file, 'bad id/../x')).toThrow();
  });
});
