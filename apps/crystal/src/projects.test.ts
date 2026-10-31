import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listProjects } from './projects.js';

describe('listProjects', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crystal-projects-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const repo = (name: string) => {
    mkdirSync(join(root, name, '.git'), { recursive: true });
    return join(root, name);
  };

  it('lists git repos under the roots, most recently used first, then by name', async () => {
    const alpha = repo('alpha');
    const beta = repo('beta');
    const gamma = repo('gamma');
    mkdirSync(join(root, 'not-a-repo'));
    writeFileSync(join(root, 'notes.md'), 'x');

    const projects = await listProjects(
      [root],
      [
        { cwd: gamma, updatedAt: 200 },
        { cwd: alpha, updatedAt: 100 },
        { cwd: gamma, updatedAt: 50 },
      ],
    );
    expect(projects).toEqual([
      { path: gamma, name: 'gamma', lastUsed: 200 },
      { path: alpha, name: 'alpha', lastUsed: 100 },
      { path: beta, name: 'beta' },
    ]);
  });

  it('adds folders sessions used outside the roots, and skips ones that no longer exist', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'crystal-elsewhere-'));
    try {
      const projects = await listProjects(
        [root],
        [
          { cwd: elsewhere, updatedAt: 10 },
          { cwd: join(root, 'deleted'), updatedAt: 20 },
        ],
      );
      expect(projects).toEqual([{ path: elsewhere, name: basename(elsewhere), lastUsed: 10 }]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('ignores a missing root, and caps the list', async () => {
    for (const name of ['a', 'b', 'c']) repo(name);
    expect(await listProjects([join(root, 'nope'), root], [], { limit: 2 })).toHaveLength(2);
  });
});
