import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSessionFile } from './files.js';

describe('readSessionFile', () => {
  let root: string;
  let quest: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crystal-files-'));
    quest = join(root, 'quest');
    outside = join(root, 'outside');
    mkdirSync(join(quest, 'docs'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(quest, 'docs', 'README.md'), '# Hello\n');
    writeFileSync(join(outside, 'secret.txt'), 'not yours');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reads a text file by a path relative to the Quest folder, and reports it relative', async () => {
    const result = await readSessionFile(quest, 'docs/README.md');
    expect(result).toEqual({ ok: true, path: 'docs/README.md', content: '# Hello\n', size: 8, truncated: false });
  });

  it('accepts an absolute path inside the Quest folder', async () => {
    const result = await readSessionFile(quest, join(quest, 'docs', 'README.md'));
    expect(result).toMatchObject({ ok: true, path: 'docs/README.md' });
  });

  it('refuses .. traversal, absolute paths elsewhere, and symlinks that lead out', async () => {
    symlinkSync(join(outside, 'secret.txt'), join(quest, 'escape.txt'));
    symlinkSync(outside, join(quest, 'escape-dir'));
    for (const path of ['../outside/secret.txt', join(outside, 'secret.txt'), 'escape.txt', 'escape-dir/secret.txt']) {
      const result = await readSessionFile(quest, path);
      expect(result.ok, path).toBe(false);
      expect(result.content, path).toBeUndefined();
      expect(result.reason, path).toMatch(/outside/);
    }
  });

  it('gives the same answer for any path outside, so it never reveals what exists elsewhere', async () => {
    for (const path of ['../outside/secret.txt', '../outside/missing.txt', '/no/such/place', '../../../../etc/hosts']) {
      expect(await readSessionFile(quest, path), path).toEqual({ ok: false, reason: "outside this Quest's folder" });
    }
  });

  it('follows a symlink that stays inside the Quest folder', async () => {
    symlinkSync(join(quest, 'docs', 'README.md'), join(quest, 'link.md'));
    expect(await readSessionFile(quest, 'link.md')).toMatchObject({ ok: true, content: '# Hello\n' });
  });

  it('refuses directories and FIFOs, and says when a file is missing', async () => {
    expect(await readSessionFile(quest, 'docs')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not a file/),
    });
    execFileSync('mkfifo', [join(quest, 'pipe')]);
    expect(await readSessionFile(quest, 'pipe')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not a file/),
    });
    expect(await readSessionFile(quest, 'nope.md')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no such/),
    });
  });

  it('refuses binary files instead of sending their bytes', async () => {
    writeFileSync(join(quest, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    writeFileSync(join(quest, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9])); // invalid UTF-8
    for (const path of ['image.png', 'latin1.txt']) {
      const result = await readSessionFile(quest, path);
      expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/binary/) });
      expect(result.content).toBeUndefined();
    }
  });

  it('caps the size, cutting at a whole character and saying so', async () => {
    writeFileSync(join(quest, 'big.txt'), `${'é'.repeat(10)}`); // 20 bytes of 2-byte characters
    const result = await readSessionFile(quest, 'big.txt', { maxBytes: 7 });
    expect(result).toMatchObject({ ok: true, size: 20, truncated: true, content: 'ééé' });
  });
});
