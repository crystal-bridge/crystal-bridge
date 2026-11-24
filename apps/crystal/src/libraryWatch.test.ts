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

  let lastEvent = 0;

  /**
   * Starts a watcher, then settles until quiet: macOS FSEvents can deliver events for the writes the setup made just
   * before the watch began, late on a busy runner. Waits until nothing has been delivered for 500 ms (up to 5 s), then
   * drops what arrived from the record.
   */
  async function start(opts: { batchMs?: number; maxFolders?: number; onIgnoreChanged?: () => void } = {}) {
    lastEvent = Date.now();
    const onIgnoreChanged = opts.onIgnoreChanged;
    const watcher = watchLibrary(root, {
      allowed: libraryFilter(root),
      onChange: (change) => {
        lastEvent = Date.now();
        changes.push(change);
      },
      onIgnoreChanged: () => {
        lastEvent = Date.now();
        onIgnoreChanged?.();
      },
      log: (msg) => logs.push(msg),
      batchMs: 300,
      ...opts,
    });
    watchers.push(watcher);
    const ceiling = Date.now() + 5000;
    while (Date.now() - lastEvent < 500 && Date.now() < ceiling) await wait(20);
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
    // Longer than a batch, so a second one would show up if the first was split.
    await wait(600);
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
    await wait(600);
    expect(changes, logs.join('\n')).toEqual([{ paths: ['notes/a.md'] }]);
  });

  it('follows a folder made, renamed and removed while watched', async () => {
    await start();
    mkdirSync(join(root, 'notes', 'new'));
    writeFileSync(join(root, 'notes', 'new', 'c.md'), '# C\n');
    await until(() => reported().includes('notes/new/c.md'));

    await wait(600);
    changes.length = 0;
    renameSync(join(root, 'notes', 'new'), join(root, 'notes', 'old'));
    writeFileSync(join(root, 'notes', 'old', 'd.md'), '# D\n');
    await until(() => reported().includes('notes/old/d.md'));
    // The folder's old name is reported, so a listing drops what was under it.
    await until(() => reported().includes('notes/new'));
    expect(reported().filter((path) => path.startsWith('notes/new/'))).toEqual([]);

    await wait(600);
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
    await start({ onIgnoreChanged });
    onIgnoreChanged.mockClear();
    writeFileSync(join(root, '.gitignore'), 'drafts/\nold/\n');
    await until(() => onIgnoreChanged.mock.calls.length > 0 && changes.some((change) => change.all));
  });

  it.skipIf(noSymlinks)('survives a symlinked folder that loops', async () => {
    symlinkSync('..', join(root, 'notes', 'loop'));
    const watcher = await start();
    writeFileSync(join(root, 'notes', 'a.md'), '# A, again\n');
    await until(() => reported().includes('notes/a.md'));
    if (process.platform === 'linux') {
      // The top and notes: the link isn't followed.
      expect(watcher.watchCount).toBe(2);
      expect(reported().filter((path) => path.includes('loop/'))).toEqual([]);
    }
  });

  it.runIf(process.platform === 'linux')(
    'on Linux, watches a folder removed and made again at once',
    async () => {
      await start();
      rmSync(join(root, 'notes'), { recursive: true });
      mkdirSync(join(root, 'notes'));
      await until(() => reported().includes('notes'));
      await wait(600);
      changes.length = 0;
      writeFileSync(join(root, 'notes', 'b.md'), '# B\n');
      mkdirSync(join(root, 'notes', 'sub'));
      await until(() => reported().includes('notes/sub'));
      writeFileSync(join(root, 'notes', 'sub', 'c.md'), '# C\n');
      await until(() => reported().includes('notes/b.md') && reported().includes('notes/sub/c.md'));
    },
    20_000,
  );

  it.runIf(process.platform !== 'win32')(
    "leaves out a name with a backslash, which isn't a separator here",
    async () => {
      await start();
      writeFileSync(join(root, 'notes', 'a\\b.md'), '# odd\n');
      mkdirSync(join(root, 'odd\\dir'));
      writeFileSync(join(root, 'notes', 'a.md'), '# A, again\n');
      await until(() => reported().includes('notes/a.md'));
      await wait(600);
      expect(reported()).toEqual(['notes/a.md']);
    },
  );

  it('leaves out a path longer than the protocol carries', async () => {
    const listeners: ((event: string, name: string) => void)[] = [];
    const fakeWatch = ((_path: string, _opts: unknown, listener: (event: string, name: string) => void) => {
      listeners.push(listener);
      return Object.assign(new EventEmitter(), { close: () => {} });
    }) as unknown as typeof fs.watch;
    // Six folders of 200 characters: the sixth's path, and the Tome in it, are past the 1,024 a path may have.
    const long = ['a', 'b', 'c', 'd', 'e', 'f'].map((letter) => letter.repeat(200));
    mkdirSync(join(root, ...long), { recursive: true });
    writeFileSync(join(root, ...long, 'x.md'), '');
    const watcher = watchLibrary(root, {
      allowed: libraryFilter(root),
      onChange: (change) => changes.push(change),
      log: (msg) => logs.push(msg),
      batchMs: 20,
      platform: 'darwin',
      watch: fakeWatch,
    });
    watchers.push(watcher);
    listeners[0]!('change', [...long, 'x.md'].join('/'));
    listeners[0]!('rename', long.join('/'));
    listeners[0]!('rename', long[0]!);
    listeners[0]!('change', 'notes/a.md');
    await until(() => changes.length > 0);
    expect(changes).toEqual([{ paths: [long[0], 'notes/a.md'] }]);
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

  it.each(['win32', 'darwin'] as const)(
    "on %s, a folder's own change event isn't a change, but one made or renamed is",
    async (platform) => {
      const listeners: ((event: string, name: string) => void)[] = [];
      const fakeWatch = ((_path: string, _opts: unknown, listener: (event: string, name: string) => void) => {
        listeners.push(listener);
        return Object.assign(new EventEmitter(), { close: () => {} });
      }) as unknown as typeof fs.watch;
      const watcher = watchLibrary(root, {
        allowed: libraryFilter(root),
        onChange: (change) => changes.push(change),
        log: (msg) => logs.push(msg),
        batchMs: 20,
        platform,
        watch: fakeWatch,
      });
      watchers.push(watcher);
      listeners[0]!('change', 'notes/a.md');
      listeners[0]!('change', 'notes');
      await until(() => changes.length > 0);
      expect(changes).toEqual([{ paths: ['notes/a.md'] }]);

      changes.length = 0;
      mkdirSync(join(root, 'newdir'));
      writeFileSync(join(root, 'newdir', 'x.md'), '# X\n');
      listeners[0]!('rename', 'newdir');
      await until(() => changes.length > 0);
      expect(changes).toEqual([{ paths: ['newdir', 'newdir/x.md'] }]);
    },
  );

  it('logs why it reports everything as changed', async () => {
    const listeners: ((event: string, name: string | null) => void)[] = [];
    const fakeWatch = ((_path: string, _opts: unknown, listener: (event: string, name: string | null) => void) => {
      listeners.push(listener);
      return Object.assign(new EventEmitter(), { close: () => {} });
    }) as unknown as typeof fs.watch;
    const watcher = watchLibrary(root, {
      allowed: libraryFilter(root),
      onChange: (change) => changes.push(change),
      log: (msg) => logs.push(msg),
      batchMs: 20,
      platform: 'darwin',
      watch: fakeWatch,
    });
    watchers.push(watcher);

    listeners[0]!('change', '.gitignore');
    await until(() => changes.length === 1);
    expect(logs.at(-1)).toContain('.gitignore changed');

    listeners[0]!('rename', null);
    await until(() => changes.length === 2);
    expect(logs.at(-1)).toContain('an event without a file name');

    for (let file = 0; file < 201; file++) {
      writeFileSync(join(root, 'notes', `n${file}.md`), '');
      listeners[0]!('change', `notes/n${file}.md`);
    }
    await until(() => changes.length === 3);
    expect(logs.at(-1)).toContain('more than 200 paths');
    expect(changes).toEqual([{ all: true }, { all: true }, { all: true }]);
    expect(logs).toHaveLength(3);
  });

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
        batchMs: 20,
        platform,
        watch: fakeWatch,
      });
      watchers.push(watcher);
      expect(emitters.length).toBeGreaterThan(0);
      expect(watcher.capped).toBe(false);
      changes.length = 0;
      logs.length = 0;
      expect(() => emitters[0]!.emit('error', new Error('too many watches'))).not.toThrow();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain('too many watches');
      // Some changes may now go unseen, so clients are told to reload.
      expect(watcher.capped, platform).toBe(true);
      await until(() => changes.length > 0);
      expect(changes, platform).toEqual([{ all: true }]);
      watcher.close();
    }
  });

  it('logs a watch it can’t open and says it is capped', () => {
    const fakeWatch = (() => {
      throw Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), { code: 'ENOSPC' });
    }) as unknown as typeof fs.watch;
    for (const platform of ['linux', 'darwin'] as const) {
      logs.length = 0;
      const watcher = watchLibrary(root, {
        allowed: libraryFilter(root),
        onChange: (change) => changes.push(change),
        log: (msg) => logs.push(msg),
        platform,
        watch: fakeWatch,
      });
      watchers.push(watcher);
      expect(watcher.capped, platform).toBe(true);
      expect(watcher.watchCount).toBe(0);
      expect(logs.join('\n')).toContain('ENOSPC');
    }
  });
});
