import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

/**
 * What to run for `claude`. Elsewhere the system finds it by name. On Windows a process can start only a real
 * executable, and npm's `claude` is a `.cmd` shim, so this looks along PATH for the executable or the one behind the shim.
 */
export function resolveClaudeBin(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string {
  if (env.CLAUDE_BIN) return env.CLAUDE_BIN;
  if (platform !== 'win32') return 'claude';
  for (const dir of (env.PATH ?? env.Path ?? '').split(win32.delimiter).filter(Boolean)) {
    for (const bin of [
      win32.join(dir, 'claude.exe'),
      win32.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    ]) {
      if (exists(bin)) return bin;
    }
  }
  return 'claude';
}
