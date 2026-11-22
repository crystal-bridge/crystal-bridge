import { userInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { scrub } from './capture.js';

describe('scrub', () => {
  it('keeps when the login expires out of a fixture, but keeps the key so the shape stays pinned', () => {
    const line = JSON.stringify({ type: 'result', credential_expires_at: '2026-11-26T07:18:25.304Z', is_error: false });
    const scrubbed = JSON.parse(scrub(line, '')) as Record<string, unknown>;
    expect(scrubbed.credential_expires_at).toBe('1970-01-01T00:00:00.000Z');
    expect(scrubbed.is_error).toBe(false);
  });

  it('keeps this machine’s account name out, as a file listing’s owner shows it', () => {
    const user = userInfo().username;
    const listing = `-rw-rw-r-- 1 ${user} ${user} 12 Nov 21 06:31 README.md`;
    const line = JSON.stringify({ type: 'user', tool_use_result: { stdout: listing } });
    const scrubbed = scrub(line, '');
    expect(scrubbed).not.toMatch(new RegExp(`\\b${user}\\b`));
    expect(JSON.parse(scrubbed).tool_use_result.stdout).toBe('-rw-rw-r-- 1 user user 12 Nov 21 06:31 README.md');
  });

  it('keeps this machine’s user id and process ids out of the CLI’s socket path', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      messaging_socket_path: '/run/user/1000/cc-socks/1609782.sock',
    });
    expect(JSON.parse(scrub(line, '')).messaging_socket_path).toBe('/run/user/0/cc-socks/0.sock');
  });

  it('replaces an email after a JSON \\n escape and keeps the escape, so the line stays valid JSON', () => {
    const line = JSON.stringify({ type: 'user', content: 'name\nsomeone@example.org' });
    const scrubbed = scrub(line, '');
    expect(() => JSON.parse(scrubbed)).not.toThrow();
    expect(JSON.parse(scrubbed).content).toBe('name\nuser@example.com');
  });

  it('keeps the git user name out, as `git config user.name` prints it', () => {
    const line = JSON.stringify({ type: 'user', content: 'Ada Fakename\nby Ada Fakename' });
    const scrubbed = scrub(line, '', 'Ada Fakename');
    expect(scrubbed).not.toContain('Ada Fakename');
    expect(JSON.parse(scrubbed).content).toBe('user\nby user');
  });
});
