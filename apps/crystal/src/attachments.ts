/**
 * Files sent with a prompt (#14). Each Quest's land in their own private folder outside the project (so nothing ends
 * up committed), and the prompt names their paths, so the agent opens them with its own tools; the CLI's Read shows
 * images. The folder goes when the Quest is closed.
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Attachment } from '@crystal-bridge/protocol';

export const ATTACHMENTS_DIR = join(tmpdir(), 'crystal-bridge', 'attachments');

/** A file's own name, made safe: no folders, only plain characters, at most 100 long. */
export function safeName(name: string): string {
  const plain = basename(name.replaceAll('\\', '/'))
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(-100);
  return /[A-Za-z0-9]/.test(plain) ? plain : 'file';
}

/** A session's private folder for its files, created if missing; the agent gets it with `--add-dir`. */
export function attachmentDir(session: string, base = ATTACHMENTS_DIR): string {
  const dir = join(base, session);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/** Saves a prompt's files for its session and returns their paths, in order. */
export function saveAttachments(session: string, files: readonly Attachment[], base = ATTACHMENTS_DIR): string[] {
  const dir = attachmentDir(session, base);
  const stamp = Date.now();
  return files.map((file, i) => {
    const path = join(dir, `${stamp}-${i + 1}-${safeName(file.name)}`);
    writeFileSync(path, Buffer.from(file.data, 'base64'), { mode: 0o600 });
    return path;
  });
}

/** The prompt with a line per saved file, which is also what the hub stores. */
export function withAttachments(text: string, paths: readonly string[]): string {
  if (paths.length === 0) return text;
  return `${text}\n\n${paths.map((path) => `[Attached file: ${path}]`).join('\n')}`;
}

/** Removes a session's saved files. */
export function removeAttachments(session: string, base = ATTACHMENTS_DIR): void {
  rmSync(join(base, session), { recursive: true, force: true });
}
