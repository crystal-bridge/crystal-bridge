import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeAttachments, safeName, saveAttachments, withAttachments } from './attachments.js';

const SESSION = '11111111-1111-4111-8111-111111111111';

describe('attachments', () => {
  it('saves each file in a private folder for its session and gives back the paths', () => {
    const base = mkdtempSync(join(tmpdir(), 'cb-attach-'));
    const paths = saveAttachments(
      SESSION,
      [
        { name: 'shot.png', type: 'image/png', data: Buffer.from('png bytes').toString('base64') },
        { name: 'notes.txt', type: 'text/plain', data: Buffer.from('hello').toString('base64') },
      ],
      base,
    );
    expect(paths).toHaveLength(2);
    expect(dirname(paths[0]!)).toBe(join(base, SESSION));
    expect(readFileSync(paths[0]!, 'utf8')).toBe('png bytes');
    expect(basename(paths[1]!)).toMatch(/notes\.txt$/);
    if (process.platform !== 'win32') {
      expect(statSync(paths[0]!).mode & 0o777).toBe(0o600);
      expect(statSync(join(base, SESSION)).mode & 0o777).toBe(0o700);
    }

    removeAttachments(SESSION, base);
    expect(existsSync(join(base, SESSION))).toBe(false);
  });

  it('keeps names to a safe file name, never a path', () => {
    expect(safeName('../../etc/passwd')).toBe('passwd');
    expect(safeName('my screen shot (1).png')).toBe('my_screen_shot__1_.png');
    expect(safeName('...')).toBe('file');
    expect(safeName('a'.repeat(300)).length).toBeLessThanOrEqual(100);
  });

  it('adds the saved paths to the prompt, so the agent can open them', () => {
    expect(withAttachments('Look at this', ['/t/a.png', '/t/b.txt'])).toBe(
      'Look at this\n\n[Attached file: /t/a.png]\n[Attached file: /t/b.txt]',
    );
    expect(withAttachments('Plain', [])).toBe('Plain');
  });
});
