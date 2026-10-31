import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveClaudeBin } from './claude-bin.js';

const exists =
  (...found: string[]) =>
  (path: string) =>
    found.includes(path);

describe('resolveClaudeBin', () => {
  it('leaves the name alone off Windows, where the system finds it', () => {
    expect(resolveClaudeBin({ PATH: '/usr/bin' }, 'linux', exists())).toBe('claude');
  });

  it('prefers an explicit CLAUDE_BIN', () => {
    expect(resolveClaudeBin({ CLAUDE_BIN: 'D:\\tools\\claude.exe' }, 'win32', exists())).toBe('D:\\tools\\claude.exe');
  });

  it('finds the native install on PATH', () => {
    const bin = win32.join('C:\\Users\\a\\.local\\bin', 'claude.exe');
    expect(resolveClaudeBin({ Path: 'C:\\Windows;C:\\Users\\a\\.local\\bin' }, 'win32', exists(bin))).toBe(bin);
  });

  it('finds the executable behind an npm shim, which only a shell could run', () => {
    const dir = 'C:\\Users\\a\\AppData\\Roaming\\npm';
    const bin = win32.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    expect(resolveClaudeBin({ PATH: dir }, 'win32', exists(bin))).toBe(bin);
  });

  it('falls back to the name, so the failure names what is missing', () => {
    expect(resolveClaudeBin({ PATH: 'C:\\Windows' }, 'win32', exists())).toBe('claude');
  });
});
