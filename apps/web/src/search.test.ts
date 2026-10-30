import type { Envelope } from '@crystal-bridge/protocol';
import { describe, expect, it } from 'vitest';
import { snippet } from './search.js';

const env = (type: Envelope['type'], payload: unknown): Envelope => ({
  node: 'n',
  session: 's',
  seq: 0,
  ts: 0,
  type,
  payload,
});

describe('snippet', () => {
  it('finds the match in a prompt, follow-up or assistant reply, with some context around it', () => {
    expect(snippet(env('user.message', { text: 'please fix the flaky login test today' }), 'flaky')).toBe(
      'please fix the flaky login test today',
    );
    const long = `${'a '.repeat(60)}the flaky part ${'b '.repeat(60)}`;
    const cut = snippet(env('user.message', { text: long }), 'flaky')!;
    expect(cut.startsWith('…')).toBe(true);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).toContain('the flaky part');
    const reply = {
      engine: 'claude',
      raw: { type: 'assistant', message: { content: [{ type: 'text', text: 'Fixed the Flaky test.' }] } },
    };
    expect(snippet(env('claude.event', reply), 'flaky')).toBe('Fixed the Flaky test.');
  });

  it('matches inside tool calls too, and skips events that only match in their JSON plumbing', () => {
    const tool = {
      engine: 'claude',
      raw: {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'grep flaky src' } }] },
      },
    };
    expect(snippet(env('claude.event', tool), 'flaky')).toBe('Bash: grep flaky src');
    expect(
      snippet(
        env('claude.event', { engine: 'claude', raw: { type: 'system', subtype: 'init', cwd: '/flaky' } }),
        'flaky',
      ),
    ).toBeUndefined();
  });
});
