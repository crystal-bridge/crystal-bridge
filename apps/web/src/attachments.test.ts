import { describe, expect, it } from 'vitest';
import { MAX_ATTACHMENTS } from '@crystal-bridge/protocol';
import { addFiles, attachedPaths, toAttachments } from './attachments.js';

const file = (name: string, size: number, type = 'image/png') => new File([new Uint8Array(size)], name, { type });

describe('attachments', () => {
  it('reads files as base64 attachments', async () => {
    const [a] = await toAttachments([new File(['hello'], 'a.txt', { type: 'text/plain' })]);
    expect(a).toEqual({ name: 'a.txt', type: 'text/plain', data: btoa('hello') });
  });

  it("adds files up to the limits, saying which it couldn't take", () => {
    const { files, error } = addFiles([], [file('a.png', 10), file('big.png', 6_000_000)]);
    expect(files.map((f) => f.name)).toEqual(['a.png']);
    expect(error).toContain('big.png is over 5 MB');
    const full = Array.from({ length: MAX_ATTACHMENTS }, (_, i) => file(`${i}.png`, 1));
    expect(addFiles(full, [file('one-more.png', 1)]).error).toContain(`up to ${MAX_ATTACHMENTS} files`);
  });

  it('finds the attached-file lines a node added to a prompt', () => {
    expect(attachedPaths('Look\n\n[Attached file: /t/a.png]\n[Attached file: /t/b.txt]')).toEqual({
      text: 'Look',
      paths: ['/t/a.png', '/t/b.txt'],
    });
    expect(attachedPaths('Plain')).toEqual({ text: 'Plain', paths: [] });
  });
});
