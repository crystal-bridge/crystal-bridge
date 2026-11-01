import { describe, expect, it, vi } from 'vitest';
import type { Envelope } from '@crystal-bridge/protocol';
import allowFixture from './__fixtures__/allow.ndjson?raw';
import backgroundAgentFixture from './__fixtures__/background-agent.ndjson?raw';
import denyFixture from './__fixtures__/deny.ndjson?raw';
import {
  buildView,
  IncrementalView,
  insertBySeq,
  sessionEffort,
  sessionMode,
  slashCommands,
  ViewBuilder,
  type ViewItem,
} from './model.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const PROMPT = 'Run `touch crystal.txt`, then reply DONE.';

function lines(fixture: string): unknown[] {
  return fixture
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as unknown);
}

/** Builds envelopes with consecutive seqs, starting at 0. */
class Stream {
  readonly envelopes: Envelope[] = [];

  push(type: Envelope['type'], payload: unknown): this {
    this.envelopes.push({ node: 'node-a', session: SESSION, seq: this.envelopes.length, ts: 0, type, payload });
    return this;
  }

  started(prompt = PROMPT): this {
    return this.push('session.started', { cwd: '/tmp/FIXTURE', prompt, label: 'test' });
  }

  claude(raws: unknown[]): this {
    for (const raw of raws) this.push('claude.event', { engine: 'claude', raw });
    return this;
  }

  get lastSeq(): number {
    return this.envelopes.length - 1;
  }
}

function fixtureCommand(fixture: string): string {
  for (const raw of lines(fixture) as { type?: string; message?: { content?: unknown[] } }[]) {
    if (raw.type !== 'assistant') continue;
    for (const block of raw.message?.content ?? []) {
      const b = block as { type?: string; name?: string; input?: { command?: string } };
      if (b.type === 'tool_use' && b.name === 'Bash' && b.input?.command) return b.input.command;
    }
  }
  throw new Error('fixture has no Bash tool_use');
}

function ofKind<K extends ViewItem['kind']>(items: ViewItem[], kind: K): Extract<ViewItem, { kind: K }>[] {
  return items.filter((item): item is Extract<ViewItem, { kind: K }> => item.kind === kind);
}

const textDelta = (text: string, msgId = 'msg_x', index = 0) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
  api_message_id: msgId,
});
const messageStart = (msgId = 'msg_x') => ({
  type: 'stream_event',
  event: { type: 'message_start', message: { id: msgId, content: [] } },
  api_message_id: msgId,
});
const textBlockStart = (msgId = 'msg_x', index = 0) => ({
  type: 'stream_event',
  event: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
  api_message_id: msgId,
});
const assistantText = (text: string, msgId = 'msg_x') => ({
  type: 'assistant',
  message: { id: msgId, role: 'assistant', content: [{ type: 'text', text }] },
});

describe('buildView over allow.ndjson', () => {
  const stream = new Stream().started().claude(lines(allowFixture));
  const items = buildView(stream.envelopes);

  it('yields prompt, Bash tool with output, DONE text and a result, in order', () => {
    const kinds = items.map((item) => item.kind);
    expect(kinds).toEqual(['user', 'tool', 'assistant', 'result']);

    const [user, tool, assistant, result] = items;
    expect(user).toMatchObject({ kind: 'user', text: PROMPT });
    expect(tool).toMatchObject({
      kind: 'tool',
      name: 'Bash',
      input: { command: fixtureCommand(allowFixture) },
      output: '(Bash completed with no output)',
      isError: false,
      denied: false,
    });
    expect(fixtureCommand(allowFixture)).toBe('touch crystal.txt');
    expect(assistant).toMatchObject({ kind: 'assistant', streaming: false });
    expect(assistant?.kind === 'assistant' && assistant.text).toContain('DONE');
    expect(result).toMatchObject({ kind: 'result', subtype: 'success', isError: false, text: 'DONE' });
    expect(result?.kind === 'result' && result.costUsd).toBeCloseTo(0.1270636);
  });
});

describe('permission card placement', () => {
  const TOOL_USE_ID = 'toolu_01AQMN5ZMEjwoXhwWZR58Pjx';
  const raws = lines(allowFixture) as { type?: string }[];
  // The CLI asks for permission after streaming the tool_use and before it runs the tool.
  const firstToolResult = raws.findIndex((raw) => raw.type === 'user');

  it('places a permission request just before the tool card it belongs to', () => {
    const stream = new Stream()
      .started()
      .claude(raws.slice(0, firstToolResult))
      .push('permission.request', {
        requestId: 'r1',
        toolName: 'Bash',
        input: { command: 'touch crystal.txt' },
        toolUseId: TOOL_USE_ID,
      })
      .push('permission.resolved', { requestId: 'r1', behavior: 'allow' })
      .claude(raws.slice(firstToolResult));

    expect(buildView(stream.envelopes).map((item) => item.kind)).toEqual([
      'user',
      'permission',
      'tool',
      'assistant',
      'result',
    ]);
  });

  it('leaves a request with no matching tool where it arrived', () => {
    const stream = new Stream()
      .started()
      .claude(raws.slice(0, firstToolResult))
      .push('permission.request', { requestId: 'r1', toolName: 'Bash', input: {}, toolUseId: 'toolu_other' });

    expect(buildView(stream.envelopes).map((item) => item.kind)).toEqual(['user', 'tool', 'permission']);
  });
});

describe('buildView over deny.ndjson', () => {
  it('marks the Bash tool as an error and denied', () => {
    const items = buildView(new Stream().started().claude(lines(denyFixture)).envelopes);
    const [tool] = ofKind(items, 'tool');
    expect(tool).toMatchObject({ name: 'Bash', isError: true, denied: true, output: 'denied in capture' });
    const texts = ofKind(items, 'assistant');
    expect(texts).toHaveLength(1);
    expect(texts[0]?.text).toContain('denied');
  });
});

describe('streaming assistant text', () => {
  it('accumulates text deltas while the message streams', () => {
    const stream = new Stream().started().claude([messageStart(), textBlockStart(), textDelta('Hel'), textDelta('lo')]);
    const texts = ofKind(buildView(stream.envelopes), 'assistant');
    expect(texts).toEqual([expect.objectContaining({ text: 'Hello', streaming: true })]);
  });

  it('replaces partial text with the final assistant message without duplicating it', () => {
    const stream = new Stream()
      .started()
      .claude([messageStart(), textBlockStart(), textDelta('Hel'), textDelta('lo'), assistantText('Hello!')]);
    const texts = ofKind(buildView(stream.envelopes), 'assistant');
    expect(texts).toEqual([expect.objectContaining({ text: 'Hello!', streaming: false })]);
  });

  it('accepts deltas without a preceding content_block_start', () => {
    const stream = new Stream().started().claude([textDelta('Hi'), assistantText('Hi')]);
    expect(ofKind(buildView(stream.envelopes), 'assistant')).toEqual([
      expect.objectContaining({ text: 'Hi', streaming: false }),
    ]);
  });
});

describe('permissions', () => {
  const request = {
    requestId: 'req-1',
    toolName: 'Bash',
    input: { command: 'touch crystal.txt' },
    toolUseId: 'toolu_1',
  };

  it('is pending without a matching resolution', () => {
    const items = buildView(new Stream().started().push('permission.request', request).envelopes);
    expect(ofKind(items, 'permission')).toEqual([
      expect.objectContaining({ requestId: 'req-1', toolName: 'Bash', input: request.input, pending: true }),
    ]);
    expect(ofKind(items, 'permission')[0]?.behavior).toBeUndefined();
  });

  it('is resolved once matched', () => {
    const items = buildView(
      new Stream()
        .started()
        .push('permission.request', request)
        .push('permission.resolved', { requestId: 'req-1', behavior: 'deny' }).envelopes,
    );
    expect(ofKind(items, 'permission')).toEqual([
      expect.objectContaining({ requestId: 'req-1', pending: false, behavior: 'deny' }),
    ]);
  });

  it('ignores a resolution for an unknown request', () => {
    const items = buildView(
      new Stream().started().push('permission.resolved', { requestId: 'nope', behavior: 'allow' }).envelopes,
    );
    expect(ofKind(items, 'permission')).toEqual([]);
  });
});

describe('robustness', () => {
  it('yields nothing for unknown raw types and malformed payloads', () => {
    const stream = new Stream()
      .started()
      .claude([
        { type: 'mystery' },
        null,
        42,
        'text',
        { type: 'stream_event' },
        { type: 'assistant' },
        { type: 'user' },
      ])
      .push('claude.event', null)
      .push('permission.request', { nope: true });
    expect(() => buildView(stream.envelopes)).not.toThrow();
    expect(buildView(stream.envelopes).map((item) => item.kind)).toEqual(['user']);
  });

  it('orders by seq and ignores duplicate seqs', () => {
    const stream = new Stream().started().claude([assistantText('one', 'm1'), assistantText('two', 'm2')]);
    const shuffled = [stream.envelopes[2]!, stream.envelopes[0]!, stream.envelopes[1]!, stream.envelopes[1]!];
    expect(ofKind(buildView(shuffled), 'assistant').map((item) => item.text)).toEqual(['one', 'two']);
  });
});

describe('session lifecycle', () => {
  it('yields an ended item for session.ended', () => {
    const items = buildView(
      new Stream().started().push('session.ended', { exitCode: 0, signal: null, reason: 'exit' }).envelopes,
    );
    expect(items.at(-1)).toMatchObject({ kind: 'ended', exitCode: 0, signal: null, reason: 'exit' });
  });

  it('defaults an ended item without a reason to exit', () => {
    const items = buildView(new Stream().started().push('session.ended', { exitCode: 0, signal: null }).envelopes);
    expect(items.at(-1)).toMatchObject({ kind: 'ended', reason: 'exit' });
  });

  it('yields a resumed item for session.resumed, after the idle end it follows', () => {
    const stream = new Stream()
      .started()
      .push('session.ended', { exitCode: 0, signal: null, reason: 'idle' })
      .push('user.message', { text: 'back again' })
      .push('session.resumed', {});
    const items = buildView(stream.envelopes);
    expect(items.slice(-3)).toMatchObject([
      { kind: 'ended', reason: 'idle' },
      { kind: 'user', text: 'back again' },
      { kind: 'resumed', id: `e${stream.lastSeq}` },
    ]);
  });

  it('yields an error item for error envelopes', () => {
    const items = buildView(new Stream().started().push('error', { message: 'claude crashed' }).envelopes);
    expect(items.at(-1)).toMatchObject({ kind: 'error', message: 'claude crashed' });
  });
});

describe('adopted sessions', () => {
  it('shows the first prompt once: from the replayed history, not from session.started', () => {
    const stream = new Stream()
      .push('session.started', { cwd: '/w', prompt: 'Fix it', label: 'Fix it', adopted: true })
      .push('user.message', { text: 'Fix it' })
      .claude([assistantText('Done.', 'm1')]);
    expect(buildView(stream.envelopes).map((item) => item.kind)).toEqual(['user', 'assistant']);
  });
});

describe('follow-up messages', () => {
  it('renders a user.message between turns from envelopes alone', () => {
    const stream = new Stream()
      .started()
      .claude([assistantText('DONE', 'm1')])
      .push('user.message', { text: 'Say AGAIN.' })
      .claude([assistantText('AGAIN', 'm2')]);

    const items = buildView(stream.envelopes);
    expect(items.map((item) => (item.kind === 'user' || item.kind === 'assistant' ? item.text : item.kind))).toEqual([
      PROMPT,
      'DONE',
      'Say AGAIN.',
      'AGAIN',
    ]);
    expect(items[2]).toMatchObject({ kind: 'user', id: `e${stream.lastSeq - 1}` });
  });

  it('ignores a user.message without text', () => {
    const items = buildView(new Stream().started().push('user.message', {}).envelopes);
    expect(items.filter((item) => item.kind === 'user')).toHaveLength(1);
  });
});

describe('incremental view', () => {
  const stream = new Stream()
    .started()
    .claude(lines(allowFixture))
    .push('user.message', { text: 'again' })
    .claude(lines(allowFixture).slice(0, 5));

  it('ViewBuilder fed one envelope at a time matches buildView at every step', () => {
    const builder = new ViewBuilder();
    stream.envelopes.forEach((envelope, i) => {
      builder.envelope(envelope);
      expect(builder.items).toEqual(buildView(stream.envelopes.slice(0, i + 1)));
    });
  });

  it('IncrementalView only feeds new envelopes when the list grows at the end', () => {
    const view = new IncrementalView();
    const feed = vi.spyOn(ViewBuilder.prototype, 'envelope');
    try {
      for (let n = 1; n <= stream.envelopes.length; n++) view.update(stream.envelopes.slice(0, n));
      expect(feed).toHaveBeenCalledTimes(stream.envelopes.length);
    } finally {
      feed.mockRestore();
    }
    expect(view.update(stream.envelopes)).toEqual(buildView(stream.envelopes));
  });

  it('IncrementalView returns a new array each time the items change, and the same one otherwise', () => {
    const view = new IncrementalView();
    const first = view.update(stream.envelopes.slice(0, 3));
    expect(view.update(stream.envelopes.slice(0, 3))).toBe(first);
    expect(view.update(stream.envelopes.slice(0, 4))).not.toBe(first);
  });

  it('IncrementalView keeps unchanged items identical and gives a changed item a new object', () => {
    const view = new IncrementalView();
    const s = new Stream().started().claude([messageStart(), textBlockStart(), textDelta('Hel')]);
    const before = view.update([...s.envelopes]);
    s.claude([textDelta('lo')]);
    const after = view.update([...s.envelopes]);
    // The prompt didn't change, so a memoised component can skip it; the streaming text did.
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[1]).toMatchObject({ kind: 'assistant', text: 'Hello' });
    expect(before[1]).toMatchObject({ text: 'Hel' });
  });

  it('IncrementalView empties when given an empty list', () => {
    const view = new IncrementalView();
    view.update(stream.envelopes.slice(0, 3));
    expect(view.update([])).toEqual([]);
  });

  it('IncrementalView rebuilds when an earlier envelope changes, such as an out-of-order insert', () => {
    const view = new IncrementalView();
    const all = stream.envelopes;
    const missing = 3;
    view.update(all.filter((envelope) => envelope.seq !== missing));
    expect(view.update(all)).toEqual(buildView(all));
  });
});

describe('insertBySeq', () => {
  const at = (seq: number) => ({ node: 'n', session: SESSION, seq, ts: 0, type: 'claude.event' as const, payload: {} });

  it('appends in order, inserts out-of-order envelopes in place, and drops duplicates', () => {
    const list: Envelope[] = [];
    for (const seq of [0, 1, 2, 5, 3, 4, 3, 6]) insertBySeq(list, at(seq));
    expect(list.map((envelope) => envelope.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('reports whether it stored the envelope', () => {
    const list: Envelope[] = [];
    expect(insertBySeq(list, at(0))).toBe(true);
    expect(insertBySeq(list, at(0))).toBe(false);
  });
});

describe('sessionEffort', () => {
  it('is the Quest’s latest choice, or what it started with', () => {
    const started: Envelope = {
      node: 'n',
      session: '11111111-1111-4111-8111-111111111111',
      seq: 0,
      ts: 0,
      type: 'session.started',
      payload: { cwd: '/w', prompt: 'p', label: 'p', effort: 'high' },
    };
    const changed = (seq: number, payload: unknown): Envelope => ({ ...started, seq, type: 'session.effort', payload });
    expect(sessionEffort([started])).toBe('high');
    expect(sessionEffort([started, changed(1, { effort: 'low' })])).toBe('low');
    expect(sessionEffort([started, changed(1, { effort: 'low' }), changed(2, {})])).toBeUndefined();
  });
});

describe('sessionMode', () => {
  it('is the permission mode the CLI last reported, from init or a status update', () => {
    const stream = new Stream().started().claude([{ type: 'system', subtype: 'init', permissionMode: 'auto' }]);
    expect(sessionMode(stream.envelopes)).toBe('auto');
    stream.claude([{ type: 'system', subtype: 'status', status: null, permissionMode: 'plan' }]);
    expect(sessionMode(stream.envelopes)).toBe('plan');
    expect(sessionMode(new Stream().started().envelopes)).toBeUndefined();
  });

  it('reports the CLI-s internal name for --permission-mode manual, default, as manual', () => {
    const stream = new Stream().started().claude([{ type: 'system', subtype: 'status', permissionMode: 'default' }]);
    expect(sessionMode(stream.envelopes)).toBe('manual');
  });
});

describe('closed sessions', () => {
  it('yields a closed item, with what happened to the worktree', () => {
    const items = buildView(
      new Stream()
        .started()
        .push('session.closed', { worktree: { removed: false, reason: 'it has uncommitted changes' } }).envelopes,
    );
    expect(items.at(-1)).toMatchObject({
      kind: 'closed',
      worktree: { removed: false, reason: 'it has uncommitted changes' },
    });
  });
});

describe('slashCommands', () => {
  it('lists the commands and skills the CLI reported, without the terminal-only ones', () => {
    const stream = new Stream().started().claude([
      {
        type: 'system',
        subtype: 'init',
        slash_commands: ['loadout:code-review', 'doctor', 'compact'],
        terminal_slash_commands: ['doctor'],
      },
    ]);
    expect(slashCommands(stream.envelopes)).toEqual(['compact', 'loadout:code-review']);
    expect(slashCommands(new Stream().started().envelopes)).toEqual([]);
  });
});

describe('skills', () => {
  // As the CLI streams a skill (live check, CLI 2.1.312): the Skill tool, its result, then the skill's text as a
  // synthetic user message.
  const skillTurn = (synthetic = true) => [
    {
      type: 'assistant',
      message: {
        id: 'm1',
        content: [{ type: 'tool_use', id: 'toolu_s', name: 'Skill', input: { skill: 'demo-skill' } }],
      },
    },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_s', content: 'Launching skill: demo-skill' }] },
    },
    {
      type: 'user',
      ...(synthetic ? { isSynthetic: true } : {}),
      message: {
        content: [{ type: 'text', text: 'Base directory for this skill: /tmp/FIXTURE/demo-skill\n\n# Demo skill\n' }],
      },
    },
  ];

  it("folds the skill's text into its Skill tool instead of showing it as a notice", () => {
    const items = buildView(new Stream().started().claude(skillTurn()).envelopes);
    expect(items.filter((i) => i.kind === 'notice')).toEqual([]);
    const skill = items.find((i) => i.kind === 'tool');
    expect(skill).toMatchObject({ name: 'Skill', done: true, body: expect.stringContaining('# Demo skill') });
  });

  it('keeps user text that is not synthetic as a notice', () => {
    const items = buildView(new Stream().started().claude(skillTurn(false)).envelopes);
    expect(items.filter((i) => i.kind === 'notice')).toHaveLength(1);
  });
});

describe('a terminal asking something', () => {
  const screen = (seq: number, payload: unknown, type: Envelope['type'] = 'terminal.screen'): Envelope => ({
    node: 'n',
    session: '11111111-1111-4111-8111-111111111111',
    seq,
    ts: seq,
    type,
    payload,
  });
  const terminals = (events: Envelope[]) => buildView(events).filter((item) => item.kind === 'terminal');

  it('keeps one card, following the screen and remembering a held message', () => {
    const view = terminals([
      screen(1, { open: true, raised: true, held: true, text: 'Pick one' }),
      screen(2, { open: true, text: 'Pick two' }),
    ]);
    expect(view).toEqual([{ kind: 'terminal', id: expect.any(String), text: 'Pick two', held: true }]);
  });

  it('goes when it closes, so a replay ends the way the Quest did', () => {
    expect(terminals([screen(1, { open: true, raised: true, text: 'x' }), screen(2, { open: false })])).toEqual([]);
  });

  it('goes with the process, even if the close was never sent', () => {
    const ended = screen(2, { exitCode: 1, signal: null, reason: 'error' }, 'session.ended');
    expect(terminals([screen(1, { open: true, raised: true, text: 'x' }), ended])).toEqual([]);
  });
});

describe('helpers in the chat', () => {
  const claude = (raw: Record<string, unknown>, seq: number) =>
    ({ v: 1, seq, session: SESSION, ts: 1, type: 'claude.event', payload: { raw } }) as unknown as Envelope;
  const build = (raws: Record<string, unknown>[]) => buildView(raws.map((raw, i) => claude(raw, i)));
  const toolUse = (id: string, name: string, input: unknown, parent: string | null = null) => ({
    type: 'assistant',
    parent_tool_use_id: parent,
    message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name, input }] },
  });
  const toolResult = (id: string, content: string, extra: Record<string, unknown> = {}, isError = false) => ({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
    ...extra,
  });
  const launch = toolUse('a1', 'Agent', {
    description: 'Security review',
    prompt: 'Look for holes',
    subagent_type: 'general-purpose',
  });
  const helper = { id: 'a1', description: 'Security review', agentType: 'general-purpose' };

  it('attributes a tool to the helper that called it, and leaves the leader-s unmarked', () => {
    const items = build([launch, toolUse('t1', 'Read', { file_path: '/a' }, 'a1'), toolUse('t2', 'Read', {})]);
    expect(items[1]).toMatchObject({ name: 'Read', helper });
    expect(items[2]).not.toHaveProperty('helper');
  });

  it('leaves a tool plain when its parent is unknown', () => {
    const items = build([toolUse('t1', 'Read', {}, 'nobody'), toolUse('h', 'SubagentHandback', {}, 'nobody')]);
    expect(items[0]).not.toHaveProperty('helper');
    expect(items[1]).toMatchObject({ name: 'SubagentHandback' });
  });

  it('marks a helper back when its foreground call returns, with that result as its report', () => {
    const items = build([launch, toolResult('a1', 'All clear')]);
    expect(items[1]).toMatchObject({ kind: 'helper-back', helper, outcome: 'returned', report: 'All clear' });
  });

  it('marks a helper failed when its call errors, and not back at all when it was denied', () => {
    expect(build([launch, toolResult('a1', 'It broke', {}, true)])[1]).toMatchObject({
      kind: 'helper-back',
      outcome: 'failed',
      report: 'It broke',
    });
    const denied = build([
      launch,
      toolResult(
        'a1',
        'Refused',
        { tool_result_meta: [{ id: 'a1', permission_decision: { decision: 'reject' } }] },
        true,
      ),
    ]);
    expect(denied.map((item) => item.kind)).toEqual(['tool']);
  });

  it('waits for a background helper-s notification, not its launch', () => {
    const launched = toolResult('a1', 'Launched', { tool_use_result: { isAsync: true } });
    expect(build([launch, launched]).map((item) => item.kind)).toEqual(['tool']);
    const finished = { type: 'system', subtype: 'task_notification', tool_use_id: 'a1', status: 'completed' };
    expect(build([launch, launched, finished])[1]).toMatchObject({ kind: 'helper-back', outcome: 'returned' });
  });

  it('gives one return line when a helper is notified twice', () => {
    const finished = { type: 'system', subtype: 'task_notification', tool_use_id: 'a1', status: 'completed' };
    expect(build([launch, finished, finished]).filter((item) => item.kind === 'helper-back')).toHaveLength(1);
    expect(build([launch, toolResult('a1', 'x'), finished]).filter((i) => i.kind === 'helper-back')).toHaveLength(1);
  });

  it('reads failed and stopped from the notification', () => {
    const ended = (status: string) => ({ type: 'system', subtype: 'task_notification', tool_use_id: 'a1', status });
    expect(build([launch, ended('failed')])[1]).toMatchObject({ outcome: 'failed' });
    expect(build([launch, ended('stopped')])[1]).toMatchObject({ outcome: 'stopped' });
    expect(build([launch, ended('killed')])[1]).toMatchObject({ outcome: 'stopped' });
  });

  it('ignores the notification of a background command', () => {
    const items = build([
      toolUse('b1', 'Bash', { command: 'sleep 1' }),
      { type: 'system', subtype: 'task_notification', tool_use_id: 'b1', status: 'completed' },
    ]);
    expect(items.map((item) => item.kind)).toEqual(['tool']);
  });

  it('turns a real background agent-s handback into its report, with no card', () => {
    const envelopes = lines(backgroundAgentFixture).map((raw, i) => claude(raw as Record<string, unknown>, i));
    const items = buildView(envelopes);
    expect(items.filter((item) => item.kind === 'tool' && item.name === 'SubagentHandback')).toEqual([]);
    const back = items.filter((item) => item.kind === 'helper-back');
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ outcome: 'returned', report: 'done' });
    expect(back[0]).toHaveProperty('helper.description', 'Say done');
  });
});
