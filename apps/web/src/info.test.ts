import type { Envelope } from '@crystal-bridge/protocol';
import { describe, expect, it } from 'vitest';
import backgroundAgent from './__fixtures__/background-agent.ndjson?raw';
import backgroundCommand from './__fixtures__/background-command.ndjson?raw';
import { sessionInfo } from './info.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
let seq = 0;
const env = (type: Envelope['type'], payload: unknown): Envelope => ({
  node: 'n',
  session: SESSION,
  seq: seq++,
  ts: 0,
  type,
  payload,
});
const raw = (r: unknown) => env('claude.event', { engine: 'claude', raw: r });
const toolUse = (id: string, name: string, input: unknown) => ({
  type: 'assistant',
  message: {
    id: `m-${id}`,
    content: [{ type: 'tool_use', id, name, input }],
    usage: { input_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500, output_tokens: 10 },
  },
});
const toolResult = (id: string) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
});
const result = (cost: number, window = 200000) => ({
  type: 'result',
  subtype: 'success',
  total_cost_usd: cost,
  modelUsage: { 'model-x': { contextWindow: window } },
});

describe('sessionInfo', () => {
  it('reports the model, mode, project and branch', () => {
    seq = 0;
    const info = sessionInfo([
      env('session.started', {
        cwd: '/r/.worktrees/ab',
        prompt: 'p',
        label: 'p',
        worktree: { root: '/r', branch: 'cb/ab' },
      }),
      raw({ type: 'system', subtype: 'init', model: 'model-x', permissionMode: 'auto', cwd: '/r/.worktrees/ab' }),
    ]);
    expect(info).toMatchObject({ cwd: '/r/.worktrees/ab', branch: 'cb/ab', model: 'model-x', mode: 'auto' });
  });

  it('knows the window during the first turn, before any result, from the engine-s announcement', () => {
    seq = 0;
    const info = sessionInfo([
      env('session.started', { cwd: '/r', prompt: 'p', label: 'p' }),
      raw({ type: 'system', subtype: 'init', model: 'model-x' }),
      raw({ type: 'system', subtype: 'context_window', contextWindow: 1000000 }),
      raw(toolUse('t1', 'Bash', { command: 'ls' })),
    ]);
    expect(info.context).toEqual({ used: 1502, window: 1000000 });
  });

  it('measures MP to where the session compacts, keeping the whole window for the words', () => {
    seq = 0;
    const info = sessionInfo([
      env('session.started', { cwd: '/r', prompt: 'p', label: 'p' }),
      raw({ type: 'system', subtype: 'context_window', contextWindow: 1000000, compactWindow: 800000 }),
      raw(toolUse('t1', 'Bash', { command: 'ls' })),
    ]);
    expect(info.context).toEqual({ used: 1502, window: 1000000, limit: 800000 });
  });

  it('never measures past the window, and leaves the limit out when compaction is no sooner', () => {
    seq = 0;
    const info = sessionInfo([
      env('session.started', { cwd: '/r', prompt: 'p', label: 'p' }),
      raw({ type: 'system', subtype: 'context_window', contextWindow: 200000, compactWindow: 800000 }),
      raw(toolUse('t1', 'Bash', { command: 'ls' })),
    ]);
    expect(info.context).toEqual({ used: 1502, window: 200000 });
  });

  it('has a limit before the stream engine-s first result gives the window', () => {
    seq = 0;
    const info = sessionInfo([
      env('session.started', { cwd: '/r', prompt: 'p', label: 'p' }),
      raw({ type: 'system', subtype: 'context_window', compactWindow: 800000 }),
      raw(toolUse('t1', 'Bash', { command: 'ls' })),
    ]);
    expect(info.context).toEqual({ used: 1502, limit: 800000 });
  });

  it('measures context from the latest assistant message against the model-s window', () => {
    seq = 0;
    const info = sessionInfo([
      env('session.started', { cwd: '/r', prompt: 'p', label: 'p' }),
      raw({ type: 'system', subtype: 'init', model: 'model-x' }),
      raw(toolUse('t1', 'Bash', { command: 'ls' })),
      raw(result(0.1, 200000)),
    ]);
    expect(info.context).toEqual({ used: 1502, window: 200000 });
  });

  it('takes the running cost across resumes, which carries on rather than starting over', () => {
    seq = 0;
    const info = sessionInfo([
      env('session.started', { cwd: '/r', prompt: 'p', label: 'p' }),
      raw(result(0.6)),
      env('session.ended', { exitCode: 0, signal: null, reason: 'idle' }),
      env('session.resumed', {}),
      raw(result(5.82)),
      env('session.resumed', {}),
      raw({ type: 'result', subtype: 'error_during_execution', is_error: true }),
      raw(result(6.26)),
    ]);
    expect(info.costUsd).toBeCloseTo(6.26);
  });

  it('adds a lower running cost as a new count, in case a process does start over', () => {
    seq = 0;
    const info = sessionInfo([
      env('session.started', { cwd: '/r', prompt: 'p', label: 'p' }),
      raw(result(0.25)),
      env('session.resumed', {}),
      raw(result(0.05)),
    ]);
    expect(info.costUsd).toBeCloseTo(0.3);
  });

  it('adds up tokens, turns and working time from each turn-s result, across resumes', () => {
    seq = 0;
    const turn = (input: number, output: number, read: number, write: number, ms: number) => ({
      type: 'result',
      subtype: 'success',
      duration_ms: ms,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: write,
      },
    });
    const info = sessionInfo([
      env('session.started', { cwd: '/w', prompt: 'p', label: 'p' }),
      raw(turn(4, 90, 40000, 14000, 6000)),
      raw(turn(2, 7, 27000, 50, 3000)),
      env('session.resumed', {}),
      raw(turn(1, 3, 1000, 0, 1000)),
      raw({ type: 'result', subtype: 'error_during_execution' }),
    ]);
    expect(info.stats).toEqual({
      tokens: { input: 7, output: 100, cacheRead: 68000, cacheWrite: 14050 },
      turns: 4,
      workingMs: 10000,
    });
  });

  it('starts its stats at zero before any turn finishes', () => {
    seq = 0;
    expect(sessionInfo([env('session.started', { cwd: '/w', prompt: 'p', label: 'p' })]).stats).toEqual({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      turns: 0,
      workingMs: 0,
    });
  });

  it('lists the files the session created or edited, relative to its folder, most recent first', () => {
    seq = 0;
    const info = sessionInfo([
      env('session.started', { cwd: '/r', prompt: 'p', label: 'p' }),
      raw(toolUse('a', 'Write', { file_path: '/r/src/new.ts', content: 'x' })),
      raw(toolUse('b', 'Edit', { file_path: '/r/src/app.ts', old_string: 'a', new_string: 'b' })),
      raw(toolUse('c', 'Edit', { file_path: '/r/src/app.ts', old_string: 'b', new_string: 'c' })),
      raw(toolUse('d', 'Read', { file_path: '/r/README.md' })),
      raw(toolUse('e', 'NotebookEdit', { notebook_path: '/elsewhere/n.ipynb', new_source: '' })),
    ]);
    expect(info.outputs).toEqual([
      { path: '/elsewhere/n.ipynb', display: '/elsewhere/n.ipynb', kind: 'edited', changes: 1 },
      { path: '/r/src/app.ts', display: 'src/app.ts', kind: 'edited', changes: 2 },
      { path: '/r/src/new.ts', display: 'src/new.ts', kind: 'created', changes: 1 },
    ]);
  });

  it('keeps a background agent in the party from its launch until the CLI reports it finished', () => {
    seq = 0;
    const lines = backgroundAgent
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; subtype?: string });
    const notified = lines.findIndex((line) => line.subtype === 'task_notification');
    const running = (count: number) =>
      sessionInfo([env('session.started', { cwd: '/r', prompt: 'p', label: 'p' }), ...lines.slice(0, count).map(raw)])
        .tasks;
    expect(running(notified)).toMatchObject([{ kind: 'agent', description: 'Say done', running: true }]);
    expect(running(notified + 1)).toMatchObject([{ kind: 'agent', description: 'Say done', running: false }]);
  });

  it('holds a background agent the same way when only its transcript marks reach the client', () => {
    seq = 0;
    const launch = { ...toolResult('a1'), tool_use_result: { isAsync: true } };
    const before = [raw(toolUse('a1', 'Agent', { description: 'Audit the repo' })), raw(launch)];
    expect(sessionInfo(before).tasks[0]?.running).toBe(true);
    const finished = { type: 'system', subtype: 'task_notification', tool_use_id: 'a1', status: 'killed' };
    expect(sessionInfo([...before, raw(finished)]).tasks[0]?.running).toBe(false);
  });

  it('tracks subagents and background commands, running until their result comes back', () => {
    seq = 0;
    const info = sessionInfo([
      env('session.started', { cwd: '/r', prompt: 'p', label: 'p' }),
      raw(toolUse('a1', 'Task', { description: 'Review the diff', subagent_type: 'general-purpose' })),
      raw(toolUse('a2', 'Agent', { description: 'Find the flaky test' })),
      raw(toolResult('a1')),
      raw(
        toolUse('b1', 'Bash', { command: 'npm run dev', description: 'Start the dev server', run_in_background: true }),
      ),
      raw(toolUse('b2', 'Bash', { command: 'ls' })),
    ]);
    expect(info.tasks).toEqual([
      { id: 'a1', kind: 'agent', description: 'Review the diff', running: false, agentType: 'general-purpose' },
      { id: 'a2', kind: 'agent', description: 'Find the flaky test', running: true },
      { id: 'b1', kind: 'background', description: 'Start the dev server', running: true },
    ]);
  });

  it('reads the effort a session started with', () => {
    seq = 0;
    const info = sessionInfo([env('session.started', { cwd: '/r', prompt: 'p', label: 'p', effort: 'xhigh' })]);
    expect(info.effort).toBe('xhigh');
  });

  it('drops a background command and a Monitor when they finish, and a command that was stopped', () => {
    seq = 0;
    const lines = backgroundCommand
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; subtype?: string; status?: string });
    const at = (status: string) =>
      lines.map((line) => line.subtype === 'task_notification' && line.status === status).lastIndexOf(true);
    const running = (count: number) =>
      sessionInfo([env('session.started', { cwd: '/r', prompt: 'p', label: 'p' }), ...lines.slice(0, count).map(raw)])
        .tasks.filter((task) => task.running)
        .map((task) => task.description);

    const firstResult = lines.findIndex((line) => line.type === 'result');
    expect(running(firstResult + 1)).toEqual(['Short ping', 'Long ping', 'Short watch']);
    expect(running(at('completed') + 1)).toEqual(['Long ping']);
    expect(running(at('stopped') + 1)).toEqual([]);
  });

  it('drops a stopped command when the stop is all that says so, as in an interactive transcript', () => {
    seq = 0;
    const launch = { ...toolResult('b1'), tool_use_result: { backgroundTaskId: 'task1' } };
    const before = [
      env('session.started', { cwd: '/r', prompt: 'p', label: 'p' }),
      raw(toolUse('b1', 'Bash', { command: 'ping', run_in_background: true })),
      raw(launch),
      raw(toolUse('s1', 'TaskStop', { task_id: 'task1' })),
    ];
    const stopped = { ...toolResult('s1'), tool_use_result: { task_id: 'task1' } };

    expect(sessionInfo(before).tasks[0]?.running).toBe(true);
    expect(sessionInfo([...before, raw(stopped)]).tasks[0]?.running).toBe(false);
  });

  it('keeps a Monitor running when a stop aimed at it failed', () => {
    seq = 0;
    const launch = { ...toolResult('m1'), tool_use_result: { taskId: 'task1' } };
    const info = sessionInfo([
      env('session.started', { cwd: '/r', prompt: 'p', label: 'p' }),
      raw(toolUse('m1', 'Monitor', { description: 'Watch' })),
      raw(launch),
      raw(toolUse('s1', 'TaskStop', { task_id: 'task1' })),
      raw({ ...toolResult('s1'), tool_use_result: { message: 'No such task' } }),
    ]);
    expect(info.tasks[0]?.running).toBe(true);
  });

  it('tracks a Monitor as a Side Quest too, running until the CLI reports it ended', () => {
    seq = 0;
    const info = sessionInfo([
      env('session.started', { cwd: '/r', prompt: 'p', label: 'p' }),
      raw(toolUse('m1', 'Monitor', { description: 'Watch the deploy log' })),
      raw(toolResult('m1')),
    ]);
    expect(info.tasks).toEqual([{ id: 'm1', kind: 'monitor', description: 'Watch the deploy log', running: true }]);
  });

  it('marks everything still running as stopped once the process ends', () => {
    seq = 0;
    const info = sessionInfo([
      env('session.started', { cwd: '/r', prompt: 'p', label: 'p' }),
      raw(toolUse('a2', 'Agent', { description: 'Find the flaky test' })),
      env('session.ended', { exitCode: 0, signal: null, reason: 'exit' }),
    ]);
    expect(info.tasks[0]?.running).toBe(false);
  });
});
