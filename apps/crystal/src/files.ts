import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** What the read-only viewer gets back for one file; `reason` says, in plain words, why `ok` is false. */
export interface FileRead {
  ok: boolean;
  /** Relative to the Quest's folder. */
  path?: string;
  content?: string;
  /** The whole file's size in bytes, even when `content` was cut. */
  size?: number;
  truncated?: boolean;
  reason?: string;
}

/** Big enough for any source file or doc; a log that size is cut, with `truncated`. */
export const MAX_FILE_BYTES = 512 * 1024;

const OUTSIDE = "outside this Quest's folder";

/** `path` is the folder itself or somewhere under it. */
function within(folder: string, path: string): boolean {
  return path === folder || path.startsWith(folder + sep);
}

/**
 * Reads one text file inside a Quest's folder for the viewer. The path resolves against `cwd` (absolute paths are
 * taken as given), and the real path, symlinks followed, must stay inside the folder's real path: `..`, absolute
 * paths elsewhere and symlinks that lead out are refused. Only regular files are read (no directories, devices or
 * FIFOs); binary files (a NUL byte, or not UTF-8) are refused rather than sent. Content is never logged.
 */
export async function readSessionFile(
  cwd: string,
  requested: string,
  { maxBytes = MAX_FILE_BYTES }: { maxBytes?: number } = {},
): Promise<FileRead> {
  let root: string;
  try {
    root = await realpath(cwd);
  } catch {
    return { ok: false, reason: "this Quest's folder no longer exists" };
  }

  // First as written, before touching the disk: anything outside gets the same answer whether or not it exists.
  const asked = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  if (!within(resolve(cwd), asked) && !within(root, asked)) return { ok: false, reason: OUTSIDE };

  // Then for real, symlinks followed, so a link inside can't lead out.
  let target: string;
  try {
    target = await realpath(asked);
  } catch {
    return { ok: false, reason: 'no such file' };
  }
  if (!within(root, target)) return { ok: false, reason: OUTSIDE };
  // The viewer's form on every system.
  const path = relative(root, target).split(sep).join('/');

  let size: number;
  try {
    const info = await stat(target);
    if (!info.isFile()) return { ok: false, path, reason: 'not a file' };
    size = info.size;
  } catch {
    return { ok: false, path, reason: 'no such file' };
  }

  const length = Math.min(size, maxBytes);
  const buffer = Buffer.alloc(length);
  const handle = await open(target, 'r');
  let read = 0;
  try {
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
  } finally {
    await handle.close();
  }
  const bytes = buffer.subarray(0, read);
  const truncated = size > read;

  if (bytes.includes(0)) return { ok: false, path, size, reason: 'binary file' };
  let content: string;
  try {
    // A cut can split a multi-byte character; streaming holds that tail back instead of calling it invalid.
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated });
  } catch {
    return { ok: false, path, size, reason: 'binary file' };
  }
  return { ok: true, path, content, size, truncated };
}
