import { describe, expect, it } from 'vitest';
import type { Envelope } from '@crystal-bridge/protocol';
import { currentActivity } from './activity.js';

let seq = 0;
function env(type: Envelope['type'], payload: unknown, ts = seq * 1000): Envelope {
  seq += 1;
  return { node: 'n', session: 's', seq, ts, type, payload };
}
const claude = (raw: unknown, ts?: number) => env('claude.event', { engine: 'claude', raw }, ts);
const assistant = (content: unknown[], ts?: number) =>
  claude({ type: 'assistant', message: { id: `m${seq}`, content } }, ts);
const toolUse = (id: string, name: string, input: unknown, ts?: number) =>
  assistant([{ type: 'tool_use', id, name, input }], ts);
const toolResult = (id: string, ts?: number) =>
  claude({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }, ts);

const started = env('session.started', { cwd: '/w/app', prompt: 'go', label: 'go' }, 0);

describe('currentActivity', () => {
  it('is nothing between turns', () => {
    expect(currentActivity([started])).toBeUndefined();
    expect(
      currentActivity([started, env('user.message', { text: 'hi' }), claude({ type: 'result', subtype: 'success' })]),
    ).toBeUndefined();
  });

  it('follows the turn in plain words, with when each step began', () => {
    const steps: Envelope[] = [started, env('user.message', { text: 'fix it' }, 5_000)];
    expect(currentActivity(steps)).toEqual({ text: 'Reading your message', since: 5_000, kind: 'listen' });

    steps.push(assistant([{ type: 'thinking', thinking: '' }], 6_000));
    expect(currentActivity(steps)).toEqual({ text: 'Thinking', since: 6_000, kind: 'think' });

    steps.push(toolUse('t1', 'Bash', { command: 'ssh box ps', description: 'List processes on the box' }, 7_000));
    expect(currentActivity(steps)).toEqual({ text: 'List processes on the box', since: 7_000, kind: 'run' });

    steps.push(toolResult('t1', 9_000));
    expect(currentActivity(steps)).toEqual({ text: 'Thinking it over', since: 9_000, kind: 'think' });

    steps.push(toolUse('t2', 'Edit', { file_path: '/w/app/src/a.ts' }, 10_000));
    expect(currentActivity(steps)?.text).toBe('Editing src/a.ts');

    steps.push(toolResult('t2'), assistant([{ type: 'text', text: 'Done' }], 12_000));
    expect(currentActivity(steps)).toEqual({ text: 'Writing a reply', since: 12_000, kind: 'reply' });
  });

  it('names the step that is waiting on you, and goes back to work once answered', () => {
    const steps: Envelope[] = [
      started,
      env('user.message', { text: 'go' }),
      toolUse('t1', 'Bash', { command: 'touch x' }),
      env('permission.request', { requestId: 'r1', toolName: 'Bash', input: { command: 'touch x' } }, 20_000),
    ];
    expect(currentActivity(steps)).toEqual({
      text: 'Waiting for your approval: touch x',
      since: 20_000,
      waiting: true,
      kind: 'wait',
    });
    steps.push(env('permission.resolved', { requestId: 'r1', behavior: 'allow' }, 25_000));
    expect(currentActivity(steps)).toEqual({ text: 'touch x', since: 25_000, kind: 'run' });
  });

  it('describes common tools, and Heroes sent out', () => {
    const one = (name: string, input: unknown) =>
      currentActivity([started, env('user.message', { text: 'go' }), toolUse('t', name, input)])?.text;
    expect(one('Read', { file_path: '/w/app/README.md' })).toBe('Reading README.md');
    expect(one('Write', { file_path: '/elsewhere/x.md' })).toBe('Writing /elsewhere/x.md');
    expect(one('Grep', { pattern: 'TODO' })).toBe('Searching for “TODO”');
    expect(one('WebSearch', { query: 'vitest timers' })).toBe('Searching the web: vitest timers');
    expect(one('Agent', { description: 'Find the config', subagent_type: 'Explore' })).toBe(
      'Waiting on a subagent: Find the config',
    );
    expect(one('mcp__files__list', {})).toBe('Using list');
    expect(one('Bash', { command: 'x'.repeat(200) })?.length).toBeLessThanOrEqual(100);
  });

  it('names the kind of each step, so the theme can pick a word for it', () => {
    const kindOf = (name: string, input: unknown) =>
      currentActivity([started, env('user.message', { text: 'x' }), toolUse('t', name, input)])?.kind;
    expect(kindOf('Edit', { file_path: '/w/app/a.ts' })).toBe('write');
    expect(kindOf('Write', { file_path: '/w/app/a.ts' })).toBe('write');
    expect(kindOf('Bash', { command: 'ls' })).toBe('run');
    expect(kindOf('Read', { file_path: '/w/app/a.ts' })).toBe('read');
    expect(kindOf('Grep', { pattern: 'x' })).toBe('search');
    expect(kindOf('WebSearch', { query: 'x' })).toBe('web');
    expect(kindOf('Agent', { description: 'map it' })).toBe('delegate');
    expect(kindOf('TodoWrite', {})).toBe('plan');
    expect(kindOf('mcp__srv__do', {})).toBe('tool');
    expect(currentActivity([started, env('user.message', { text: 'x' })])?.kind).toBe('listen');
    expect(
      currentActivity([started, env('user.message', { text: 'x' }), assistant([{ type: 'thinking' }])])?.kind,
    ).toBe('think');
    expect(
      currentActivity([started, env('user.message', { text: 'x' }), assistant([{ type: 'text', text: 'hi' }])])?.kind,
    ).toBe('reply');
    expect(
      currentActivity([
        started,
        env('user.message', { text: 'x' }),
        env('permission.request', { requestId: 'r', toolName: 'Bash', input: { command: 'touch a' } }),
      ])?.kind,
    ).toBe('wait');
  });
});
