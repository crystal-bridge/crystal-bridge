import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compactWindow } from './compact.js';

const MODEL = 'model-x';

function dirs(files: { user?: unknown; project?: unknown; local?: unknown } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cb-compact-'));
  const configDir = join(root, 'config');
  const cwd = join(root, 'work');
  mkdirSync(configDir);
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  const write = (path: string, value: unknown) =>
    value !== undefined && writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  write(join(configDir, 'settings.json'), files.user);
  write(join(cwd, '.claude', 'settings.json'), files.project);
  write(join(cwd, '.claude', 'settings.local.json'), files.local);
  return { cwd, configDir, env: {} as Record<string, string | undefined>, model: MODEL };
}

describe('compactWindow', () => {
  it('is unset when nothing configures it, so the meter keeps the whole window', () => {
    expect(compactWindow(dirs())).toBeUndefined();
  });

  it('reads the environment first, in the forms the CLI takes', () => {
    const base = dirs({ user: { autoCompactWindow: 500000 } });
    expect(compactWindow({ ...base, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '800000' } })).toBe(800000);
    expect(compactWindow({ ...base, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400k' } })).toBe(400000);
  });

  it('holds the environment to the range the CLI enforces, and ignores what it can-t read', () => {
    const base = dirs({ user: { autoCompactWindow: 500000 } });
    expect(compactWindow({ ...base, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1k' } })).toBe(100000);
    expect(compactWindow({ ...base, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '9000000' } })).toBe(1000000);
    expect(compactWindow({ ...base, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: 'lots' } })).toBe(500000);
  });

  it('reads a settings file-s env block, which never reaches Crystal-s own environment', () => {
    const base = dirs({
      user: {
        env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '800000' },
        modelSettings: { [MODEL]: { autoCompactWindow: 3 } },
      },
    });
    expect(compactWindow(base)).toBe(800000);
  });

  it('prefers the model-s own setting over the top-level one, in the same file', () => {
    const base = dirs({
      user: { autoCompactWindow: 300000, modelSettings: { [MODEL]: { autoCompactWindow: 600000 } } },
    });
    expect(compactWindow(base)).toBe(600000);
    expect(compactWindow({ ...base, model: 'model-y' })).toBe(300000);
  });

  it('matches a model reported with a size suffix', () => {
    const base = dirs({ user: { modelSettings: { [MODEL]: { autoCompactWindow: 600000 } } } });
    expect(compactWindow({ ...base, model: `${MODEL}[1m]` })).toBe(600000);
  });

  it('lets local settings beat the project-s, and the project-s beat the user-s', () => {
    const user = { autoCompactWindow: 300000 };
    const project = { autoCompactWindow: 400000 };
    expect(compactWindow(dirs({ user, project }))).toBe(400000);
    expect(compactWindow(dirs({ user, project, local: { autoCompactWindow: 500000 } }))).toBe(500000);
  });

  it('takes `auto` as no fixed size, and skips a broken file', () => {
    expect(compactWindow(dirs({ user: { autoCompactWindow: 'auto' } }))).toBeUndefined();
    expect(compactWindow(dirs({ user: { autoCompactWindow: 300000 }, project: '{ nope' }))).toBe(300000);
  });
});
