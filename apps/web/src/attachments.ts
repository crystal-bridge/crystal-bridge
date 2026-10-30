import { type Attachment, MAX_ATTACHMENTS } from '@crystal-bridge/protocol';

/**
 * Files sent with a prompt (#14): picked or pasted in the prompt box, sent as base64 with it; the Kingdom saves them
 * and adds `[Attached file: <path>]` lines to the prompt, which is all the hub keeps.
 */

/** Each file's limit: 5 MB, which stays under the protocol's base64 cap. */
export const MAX_FILE_BYTES = 5_000_000;

/** Adds files to a prompt's list within the limits, and says which it couldn't take. */
export function addFiles(current: readonly File[], adding: readonly File[]): { files: File[]; error?: string } {
  const files = [...current];
  const refused: string[] = [];
  for (const file of adding) {
    if (file.size > MAX_FILE_BYTES) refused.push(`${file.name} is over 5 MB`);
    else if (files.length >= MAX_ATTACHMENTS) refused.push(`a prompt takes up to ${MAX_ATTACHMENTS} files`);
    else files.push(file);
  }
  return refused.length ? { files, error: [...new Set(refused)].join('; ') } : { files };
}

function base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error(`could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/** The files as the protocol sends them. */
export async function toAttachments(files: readonly File[]): Promise<Attachment[]> {
  return Promise.all(
    files.map(async (file) => ({
      name: file.name,
      type: file.type || 'application/octet-stream',
      data: await base64(file),
    })),
  );
}

const LINE = /^\[Attached file: (.+)\]$/;

/** A prompt's own text and the files a Kingdom attached to it, for showing them as chips. */
export function attachedPaths(text: string): { text: string; paths: string[] } {
  const lines = text.split('\n');
  const paths: string[] = [];
  while (lines.length > 0 && LINE.test(lines.at(-1)!)) paths.unshift(LINE.exec(lines.pop()!)![1]!);
  return { text: paths.length ? lines.join('\n').trimEnd() : text, paths };
}
