import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scrub, streamedLeaks } from './capture.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

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

  it('replaces a name that starts or ends with a letter outside ASCII, and keeps a longer word', () => {
    const line = JSON.stringify({ type: 'user', content: 'by Zoë Fakename, Zoëx stays' });
    expect(JSON.parse(scrub(line, '', 'Zoë Fakename')).content).toBe('by user, Zoëx stays');
    const other = JSON.stringify({ type: 'user', content: 'Émile wrote it; Émile.' });
    expect(JSON.parse(scrub(other, '', 'Émile')).content).toBe('user wrote it; user.');
    const inside = JSON.stringify({ type: 'user', content: 'Zoëx' });
    expect(JSON.parse(scrub(inside, '', 'Zoë')).content).toBe('Zoëx');
  });
});

describe('streamedLeaks', () => {
  const who = { home: '/home/me', user: 'fakeperson', gitName: 'Ada Fakename' };
  const delta = (index: number, d: Record<string, unknown>) =>
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index, delta: d },
      session_id: 's1',
      api_message_id: 'm1',
    });
  const start = (index: number) =>
    JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index }, session_id: 's1' });

  it('finds a home folder and an email split across two streamed pieces, without saying what they were', () => {
    const lines = [
      start(0),
      delta(0, { type: 'text_delta', text: 'see /ho' }),
      delta(0, { type: 'text_delta', text: 'me/me/notes and write to ada@exa' }),
      delta(0, { type: 'text_delta', text: 'mple.org' }),
      start(1),
      delta(1, { type: 'input_json_delta', partial_json: '{"body":"by Ada Fake' }),
      delta(1, { type: 'input_json_delta', partial_json: 'name"}' }),
    ];
    // Each line alone is clean.
    for (const l of lines) expect(scrub(l, '', who.gitName)).toBe(l);
    const leaks = streamedLeaks(lines, who);
    expect(leaks.join('\n')).toMatch(/home folder/);
    expect(leaks.join('\n')).toMatch(/email address/);
    expect(leaks.join('\n')).toMatch(/git user name/);
    for (const leak of leaks) {
      expect(leak).not.toContain('/home/me');
      expect(leak).not.toContain('fakeperson');
      expect(leak).not.toContain('example.org');
      expect(leak).not.toContain('Ada');
    }
  });

  it('finds the OS user name split across pieces', () => {
    const lines = [
      start(0),
      delta(0, { type: 'thinking_delta', thinking: 'owned by fake' }),
      delta(0, { type: 'thinking_delta', thinking: 'person here' }),
    ];
    expect(streamedLeaks(lines, who).join('\n')).toMatch(/OS user name/);
  });

  it('passes a clean stream, and the scrub’s own placeholders', () => {
    const lines = [
      start(0),
      delta(0, { type: 'text_delta', text: 'see /HOME/notes, ask user@example.com, ' }),
      delta(0, { type: 'text_delta', text: 'and user wrote it' }),
      'not json',
    ];
    expect(streamedLeaks(lines, who)).toEqual([]);
  });

  // The recorder's own home and names aren't known here, so the committed fixtures are checked for email addresses.
  it.each(['errand', 'title'])('finds no email address in the streamed pieces of %s.ndjson', (name) => {
    const lines = readFileSync(join(FIXTURES, `${name}.ndjson`), 'utf8')
      .split('\n')
      .filter(Boolean);
    expect(streamedLeaks(lines, { home: '', user: '', gitName: '' })).toEqual([]);
  });
});
