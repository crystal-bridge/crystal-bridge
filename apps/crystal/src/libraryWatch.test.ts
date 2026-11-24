import { EventEmitter } from 'node:events';
import type * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { libraryFilter } from './libraryPaths.js';
import { watchLibrary } from './libraryWatch.js';

// Windows lets only administrators and developer mode make them.
const noSymlinks = process.platform === 'win32';

type Change = { paths?: string[]; all?: true };

/** Polls until `check` passes, for up to five seconds: slow runners deliver file events late. */
async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the watcher');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the Library watcher (#290)', () => {
  let root: string;
  let changes: Change[];
  let logs: string[];
  let watchers: { close(): void }[];

  const reported = () => changes.flatMap((change) => change.paths ?? []);

  /**
   * Starts a watcher, then lets it settle: macOS FSEvents can deliver events for the writes the setup made just before
   * the watch began, so whatever arrives in the first moments is dropped from the record.
   */
  async function start(opts: { batchMs?: number; maxFolders?: number } = {}) {
    const watcher = watchLibrary(root, {
      allowed: libraryFilter(root),
      onChange: (change) => changes.push(change),
      log: (msg) => logs.push(msg),
      batchMs: 50,
      ...opts,
    });
    watchers.push(watcher);
    await wait(300);
    changes.length = 0;
    return watcher;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crystal-library-watch-'));
    changes = [];
    logs = [];
    watchers = [];
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes', 'a.md'), '# A\n');
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    for (let folder = 0; folder < 30; folder++) {
      const dir = join(root, 'node_modules', `p${folder}`);
      mkdirSync(dir, { recursive: true });
      for (let file = 0; file < 10; file++) writeFileSync(join(dir, `f${file}.js`), '');
    }
    mkdirSync(join(root, 'node_modules', 'x'));
    writeFileSync(join(root, 'node_modules', 'x', 'index.js'), '');
    mkdirSync(join(root, '.obsidian'));
    writeFileSync(join(root, '.obsidian', 'app.json'), '{}');
    mkdirSync(join(root, 'drafts'));
    writeFileSync(join(root, '.gitignore'), 'drafts/\n');
  });
  afterEach(() => {
    for (const watcher of watchers) watcher.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('reports a new, changed and removed Tome once per batch', async () => {
    await start();
    writeFileSync(join(root, 'notes', 'b.md'), '# B\n');
    writeFileSync(join(root, 'notes', 'a.md'), '# A, again\n');
    unlinkSync(join(root, 'notes', 'b.md'));
    await until(() => changes.length > 0);
    // Long enough for a second batch to show up if the first was split.
    await wait(300);
    expect(changes).toEqual([{ paths: ['notes/a.md', 'notes/b.md'] }]);
  });

  it('ignores .git, .obsidian, node_modules, ignored paths and its own temp files', async () => {
    await start();
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/other\n');
    writeFileSync(join(root, '.git', 'notes.md'), '');
    writeFileSync(join(root, '.obsidian', 'app.json'), '{"x":1}');
    writeFileSync(join(root, '.obsidian', 'workspace.md'), '');
    writeFileSync(join(root, 'node_modules', 'x', 'index.js'), 'x');
    writeFileSync(join(root, 'node_modules', 'x', 'readme.md'), '');
    mkdirSync(join(root, 'node_modules', 'y'));
    writeFileSync(join(root, 'drafts', 'plan.md'), '');
    mkdirSync(join(root, 'drafts', 'deeper'));
    writeFileSync(join(root, 'notes', '.tome-0123456789abcdef.tmp'), '');
    unlinkSync(join(root, 'notes', '.tome-0123456789abcdef.tmp'));
    await wait(300);
    // A Tome written after them: anything the watcher let through would arrive no later than this.
    writeFileSync(join(root, 'notes', 'a.md'), '# A, again\n');
    await until(() => changes.length > 0);
    await wait(200);
    expect(changes).toEqual([{ paths: ['notes/a.md'] }]);
  });

  it('follows a folder made, renamed and removed while watched', async () => {
    await start();
    mkdirSync(join(root, 'notes', 'new'));
    writeFileSync(join(root, 'notes', 'new', 'c.md'), '# C\n');
    await until(() => reported().includes('notes/new/c.md'));

    await wait(200);
    changes.length = 0;
    renameSync(join(root, 'notes', 'new'), join(root, 'notes', 'old'));
    writeFileSync(join(root, 'notes', 'old', 'd.md'), '# D\n');
    await until(() => reported().includes('notes/old/d.md'));
    // The folder's old name is reported, so a listing drops what was under it.
    await until(() => reported().includes('notes/new'));
    expect(reported().filter((path) => path.startsWith('notes/new/'))).toEqual([]);

    await wait(200);
    changes.length = 0;
    rmSync(join(root, 'notes', 'old'), { recursive: true });
    await until(() => reported().includes('notes/old'));
    expect(logs).toEqual([]);
  });

  it('says all changed past 200 paths', async () => {
    // A long batch, so a slow runner's 201 writes can't straddle two of them.
    await start({ batchMs: 1000 });
    for (let file = 0; file < 201; file++) writeFileSync(join(root, 'notes', `n${file}.md`), '');
    await until(() => changes.some((change) => change.all));
    expect(changes.find((change) => change.all)).toEqual({ all: true });
  });

  it('reports a change to the top-level .gitignore', async () => {
    const onIgnoreChanged = vi.fn();
    const watcher = watchLibrary(root, {
      allowed: libraryFilter(root),
      onChange: (change) => changes.push(change),
      onIgnoreChanged,
      log: (msg) => logs.push(msg),
      batchMs: 50,
    });
    watchers.push(watcher);
    await wait(300);
    changes.length = 0;
    onIgnoreChanged.mockClear();
    writeFileSync(join(root, '.gitignore'), 'drafts/\nold/\n');
    await until(() => onIgnoreChanged.mock.calls.length > 0 && changes.some((change) => change.all));
  });

  it.skipIf(noSymlinks)('survives a symlinked folder that loops', async () => {
    symlinkSync('..', join(root, 'notes', 'loop'));
    await start();
    writeFileSync(join(root, 'notes', 'a.md'), '# A, again\n');
    await until(() => reported().includes('notes/a.md'));
  });

  it.runIf(process.platform === 'linux')(
    'on Linux, keeps one watch per listed folder and stops at the cap',
    async () => {
      // With the top and notes, eight listed folders; the dot folders, node_modules and drafts aren't listed.
      for (const name of ['b', 'c', 'd', 'e', 'f', 'g']) mkdirSync(join(root, name));
      const watcher = await start({ maxFolders: 5 });
      expect(watcher.capped).toBe(true);
      expect(watcher.watchCount).toBe(5);

      const roomy = await start();
      expect(roomy.capped).toBe(false);
      expect(roomy.watchCount).toBe(8);
    },
  );

  it('logs a watcher error and keeps serving', async () => {
    const emitters: EventEmitter[] = [];
    const fakeWatch = (() => {
      const emitter = Object.assign(new EventEmitter(), {
        close: () => {},
        ref() {
          return this;
        },
        unref() {
          return this;
        },
      });
      emitters.push(emitter);
      return emitter;
    }) as unknown as typeof fs.watch;
    for (const platform of ['linux', 'darwin'] as const) {
      emitters.length = 0;
      const watcher = watchLibrary(root, {
        allowed: libraryFilter(root),
        onChange: (change) => changes.push(change),
        log: (msg) => logs.push(msg),
        platform,
        watch: fakeWatch,
      });
      watchers.push(watcher);
      expect(emitters.length).toBeGreaterThan(0);
      expect(() => emitters[0]!.emit('error', new Error('too many watches'))).not.toThrow();
      expect(logs.at(-1)).toContain('too many watches');
      watcher.close();
    }
  });
});
