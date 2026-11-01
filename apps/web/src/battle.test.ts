import { describe, expect, it } from 'vitest';
import type { Envelope } from '@crystal-bridge/protocol';
import { battleResults } from './battle.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
let seq = 0;
function env(type: Envelope['type'], payload: unknown): Envelope {
  return { node: 'n', session: SESSION, seq: seq++, ts: 0, type, payload };
}
const claude = (raw: unknown) => env('claude.event', { engine: 'claude', raw });
const toolUse = (id: string, name: string, input: unknown) =>
  claude({ type: 'assistant', message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name, input }] } });
const result = (extra: Record<string, unknown>) =>
  claude({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1000,
    total_cost_usd: 0,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
    ...extra,
  });

describe('battleResults', () => {
  it('counts a background agent as one Side Quest, whether or not its call asked for the background', () => {
    seq = 0;
    const launched = (id: string) =>
      claude({
        type: 'user',
        tool_use_result: { isAsync: true },
        message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'launched' }] },
      });
    const { quest } = battleResults([
      env('session.started', { cwd: '/w', prompt: 'p', label: 'p' }),
      toolUse('t1', 'Agent', { subagent_type: 'Explore', description: 'unset' }),
      launched('t1'),
      toolUse('t2', 'Agent', { subagent_type: 'Explore', description: 'asked', run_in_background: true }),
      launched('t2'),
      result({ total_cost_usd: 0.1, duration_ms: 1000 }),
    ]);
    expect(quest).toMatchObject({ sideQuests: 2 });
  });

  it('sums each turn on its own: cost as the change in the running total, files, Heroes and Side Quests', () => {
    seq = 0;
    const envelopes = [
      env('session.started', { cwd: '/w', prompt: 'p', label: 'p' }),
      toolUse('t1', 'Edit', { file_path: '/w/src/a.ts' }),
      toolUse('t2', 'Agent', { subagent_type: 'Explore', description: 'look around' }),
      toolUse('t3', 'Bash', { command: 'npm run watch', run_in_background: true }),
      result({ total_cost_usd: 0.25, duration_ms: 4000 }),
      toolUse('t4', 'Write', { file_path: '/w/b.md' }),
      toolUse('t5', 'Edit', { file_path: '/w/src/a.ts' }),
      result({ total_cost_usd: 0.4, duration_ms: 2000 }),
    ];
    const { turns, quest } = battleResults(envelopes);
    const first = turns.get('e4')!;
    expect(first).toMatchObject({ outcome: 'victory', turns: 1, durationMs: 4000, loot: ['src/a.ts'] });
    expect(first.costUsd).toBeCloseTo(0.25);
    expect(first.heroes).toEqual([{ id: 't2', agentType: 'Explore', description: 'look around' }]);
    expect(first.sideQuests).toBe(1);
    expect(first.tokens).toEqual({ input: 10, output: 5, cacheRead: 100, cacheWrite: 20 });
    const second = turns.get('e7')!;
    expect(second.costUsd).toBeCloseTo(0.15);
    expect(second.loot).toEqual(['b.md', 'src/a.ts']);
    expect(second.heroes).toEqual([]);

    expect(quest).toMatchObject({
      turns: 2,
      durationMs: 6000,
      sideQuests: 1,
      heroes: [{ id: 't2', agentType: 'Explore', description: 'look around' }],
    });
    expect(quest.costUsd).toBeCloseTo(0.4);
    expect(quest.loot).toEqual(['b.md', 'src/a.ts']);
    expect(quest.tokens.output).toBe(10);
  });

  it('keeps the running cost across resumes, so the Quest totals the final figure', () => {
    seq = 0;
    const envelopes = [
      env('session.started', { cwd: '/w', prompt: 'p', label: 'p' }),
      result({ total_cost_usd: 0.6 }),
      env('session.resumed', {}),
      result({ total_cost_usd: 5.82 }),
      env('session.resumed', {}),
      result({ total_cost_usd: 6.26 }),
    ];
    const { turns, quest } = battleResults(envelopes);
    expect(turns.get('e1')!.costUsd).toBeCloseTo(0.6);
    expect(turns.get('e3')!.costUsd).toBeCloseTo(5.22);
    expect(turns.get('e5')!.costUsd).toBeCloseTo(0.44);
    expect(quest.costUsd).toBeCloseTo(6.26);
  });

  it('starts over only when the running cost falls, and names how each turn ended', () => {
    seq = 0;
    const envelopes = [
      env('session.started', { cwd: '/w', prompt: 'p', label: 'p' }),
      result({ total_cost_usd: 0.3 }),
      env('session.resumed', {}),
      result({ total_cost_usd: 0.1, subtype: 'error_during_execution', is_error: true }),
      result({ total_cost_usd: 0.2, subtype: 'error_max_turns', is_error: true }),
    ];
    const { turns, quest } = battleResults(envelopes);
    expect(turns.get('e3')).toMatchObject({ outcome: 'retreat' });
    expect(turns.get('e3')!.costUsd).toBeCloseTo(0.1);
    expect(turns.get('e4')).toMatchObject({ outcome: 'ko' });
    expect(turns.get('e4')!.costUsd).toBeCloseTo(0.1);
    expect(quest.costUsd).toBeCloseTo(0.5);
  });

  it('does not count the cost again after a stopped turn that reported none', () => {
    seq = 0;
    const { turns, quest } = battleResults([
      env('session.started', { cwd: '/w', prompt: 'p', label: 'p' }),
      result({ total_cost_usd: 2 }),
      claude({ type: 'result', subtype: 'error_during_execution', is_error: true }),
      result({ total_cost_usd: 2.5 }),
    ]);
    expect(turns.get('e2')!.costUsd).toBe(0);
    expect(turns.get('e3')!.costUsd).toBeCloseTo(0.5);
    expect(quest.costUsd).toBeCloseTo(2.5);
  });

  it('takes Loot from the node-s report as well as the file tools', () => {
    seq = 0;
    const { turns, quest } = battleResults([
      env('session.started', { cwd: '/w', prompt: 'p', label: 'p' }),
      toolUse('t1', 'Edit', { file_path: '/w/a.ts' }),
      result({}),
      claude({ type: 'system', subtype: 'turn_changes', files: ['b.ts', 'a.ts'] }),
      result({}),
      claude({ type: 'system', subtype: 'turn_changes', files: ['c.ts'] }),
    ]);
    expect(turns.get('e2')!.loot).toEqual(['a.ts', 'b.ts']);
    expect(turns.get('e4')!.loot).toEqual(['c.ts']);
    expect(quest.loot).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('finds pull requests a command printed on a line of their own, once each', () => {
    seq = 0;
    const output = (content: unknown) =>
      claude({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content }] } });
    const { turns, quest } = battleResults([
      env('session.started', { cwd: '/w', prompt: 'p', label: 'p' }),
      output('Creating pull request\nhttps://github.com/o/r/pull/12\n'),
      output('url:\thttps://github.com/o/r/pull/99\nsee https://github.com/o/r/pull/98 for more'),
      output('https://github.com/o/r/actions/runs/5'),
      output([{ type: 'text', text: 'https://gitlab.example/g/r/-/merge_requests/7' }]),
      result({}),
      output('https://github.com/o/r/pull/12'),
      result({}),
    ]);
    expect(turns.get('e5')!.prs).toEqual([
      'https://github.com/o/r/pull/12',
      'https://gitlab.example/g/r/-/merge_requests/7',
    ]);
    expect(quest.prs).toEqual(['https://github.com/o/r/pull/12', 'https://gitlab.example/g/r/-/merge_requests/7']);
  });

  it('reports MP used against where the Quest compacts', () => {
    seq = 0;
    const { quest } = battleResults([
      env('session.started', { cwd: '/w', prompt: 'p', label: 'p' }),
      claude({ type: 'system', subtype: 'context_window', contextWindow: 1000000, compactWindow: 800000 }),
      claude({
        type: 'assistant',
        message: { id: 'm', content: [], usage: { input_tokens: 400000 } },
      }),
      result({}),
    ]);
    expect(quest.mpUsedPct).toBe(50);
  });

  it('reports how much of the context window the Quest last used', () => {
    seq = 0;
    const envelopes = [
      env('session.started', { cwd: '/w', prompt: 'p', label: 'p' }),
      claude({ type: 'assistant', message: { id: 'm1', content: [], usage: { input_tokens: 50_000 } } }),
      result({ modelUsage: { m: { contextWindow: 200_000 } } }),
    ];
    expect(battleResults(envelopes).quest.mpUsedPct).toBe(25);
  });
});
