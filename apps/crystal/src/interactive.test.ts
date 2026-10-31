import { EventEmitter } from 'node:events';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HookBus, InteractiveSession, type PtyLike, type PtySpawn } from './interactive.js';
import type { ClaudeSessionEvent } from './session.js';
import { liveTranscriptEvent } from './transcripts.js';

const SESSION = '11111111-1111-4111-8111-111111111111';

class FakePty implements PtyLike {
  written: string[] = [];
  killed: string[] = [];
  private data = new EventEmitter();
  private exit = new EventEmitter();
  onData(listener: (data: string) => void) {
    this.data.on('data', listener);
  }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exit.on('exit', listener);
  }
  write(data: string) {
    this.written.push(data);
  }
  kill(signal?: string) {
    this.killed.push(signal ?? 'SIGHUP');
  }
  emitData(text: string) {
    this.data.emit('data', text);
  }
  emitExit(exitCode: number) {
    this.exit.emit('exit', { exitCode });
  }
}

interface Spawned {
  file: string;
  args: string[];
  options: { cwd: string; env: Record<string, string> };
  pty: FakePty;
}

function harness(overrides: Partial<ConstructorParameters<typeof InteractiveSession>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cb-interactive-'));
  const transcript = join(dir, `${SESSION}.jsonl`);
  writeFileSync(transcript, '');
  const spawned: Spawned[] = [];
  const spawnPty: PtySpawn = (file, args, options) => {
    const pty = new FakePty();
    spawned.push({ file, args, options: options as Spawned['options'], pty });
    return pty;
  };
  const hooks = new HookBus();
  const session = new InteractiveSession({
    session: SESSION,
    cwd: dir,
    permissionMode: 'manual',
    hookUrl: `http://127.0.0.1:9/hook/${SESSION}`,
    hooks,
    settingsDir: dir,
    spawnPty,
    pollMs: 10,
    readyDelayMs: 0,
    costSettleMs: 0,
    env: {
      PATH: '/bin',
      HOME: '/home/me',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'x',
      CRYSTAL_TOKEN: 'secret',
      CLAUDE_CONFIG_DIR: '/cfg',
      // The user's own Claude Code settings, which the standard engine passes on too.
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
    },
    ...overrides,
  });
  const events: ClaudeSessionEvent[] = [];
  session.on('event', (event) => events.push(event));
  const hook = (event: string, body: Record<string, unknown> = {}) =>
    hooks.dispatch(SESSION, event, { hook_event_name: event, transcript_path: transcript, ...body });
  const line = (record: unknown) => appendFileSync(transcript, `${JSON.stringify(record)}\n`);
  return { session, spawned, events, hook, line, transcript, dir };
}

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `ready()` holds (or `ms` pass), for timers whose firing a busy CI runner can delay. */
async function until(ready: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready() && Date.now() < deadline) await tick(5);
}

const assistant = (id: string, content: unknown[]) => ({
  type: 'assistant',
  isSidechain: false,
  message: { id, role: 'assistant', content },
});

describe('liveTranscriptEvent', () => {
  it('passes main-thread assistant lines and tool results through as stream-json shaped raw lines', () => {
    const line = assistant('m1', [{ type: 'text', text: 'hi' }]);
    expect(liveTranscriptEvent(line)).toEqual({ engine: 'claude', raw: { type: 'assistant', message: line.message } });
    const result = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    };
    expect(liveTranscriptEvent(result)).toEqual({ engine: 'claude', raw: { type: 'user', message: result.message } });
  });

  it('keeps the mark of a background launch on its tool result, and nothing else the transcript adds', () => {
    const message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'launched' }] };
    const toolUseResult = { isAsync: true, status: 'async_launched', agentId: 'a1', prompt: 'a long prompt' };
    expect(liveTranscriptEvent({ type: 'user', message, toolUseResult })).toEqual({
      engine: 'claude',
      raw: { type: 'user', message, tool_use_result: { isAsync: true } },
    });
  });

  const notification = (id: string, status: string) =>
    `<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n</task-notification>`;
  const finished = (id: string, status: string) => ({
    engine: 'claude',
    raw: { type: 'system', subtype: 'task_notification', tool_use_id: id, status },
  });

  it('turns a finished task into the system line stream-json reports, however the transcript recorded it', () => {
    const content = notification('t1', 'completed');
    expect(liveTranscriptEvent({ type: 'queue-operation', operation: 'enqueue', content })).toEqual(
      finished('t1', 'completed'),
    );
    const delivered = {
      type: 'user',
      origin: { kind: 'task-notification' },
      message: { role: 'user', content: notification('t2', 'failed') },
    };
    expect(liveTranscriptEvent(delivered)).toEqual(finished('t2', 'failed'));
  });

  it('reads no finished task from other queue lines, or from a prompt quoting one', () => {
    const content = notification('t1', 'completed');
    expect(liveTranscriptEvent({ type: 'queue-operation', operation: 'remove', content })).toBeUndefined();
    expect(liveTranscriptEvent({ type: 'queue-operation', operation: 'enqueue', content: 'hi' })).toBeUndefined();
    expect(liveTranscriptEvent({ type: 'user', message: { role: 'user', content } })).toBeUndefined();
  });

  it('skips typed prompts (Crystal records those itself), sidechains and bookkeeping lines', () => {
    expect(liveTranscriptEvent({ type: 'user', message: { role: 'user', content: 'do it' } })).toBeUndefined();
    expect(liveTranscriptEvent({ ...assistant('m2', []), isSidechain: true })).toBeUndefined();
    expect(liveTranscriptEvent({ type: 'attachment', attachment: {} })).toBeUndefined();
    expect(liveTranscriptEvent({ type: 'cost-state', totalCostUSD: 1 })).toBeUndefined();
  });
});

describe('InteractiveSession', () => {
  afterEach(() => {});

  it('runs the interactive claude with Crystal hooks in a generated settings file, and a clean environment', () => {
    const { session, spawned } = harness({ chrome: true });
    session.start('hello');
    const { file, args, options } = spawned[0]!;
    expect(file).toBe('claude');
    expect(args).toEqual([
      '--session-id',
      SESSION,
      '--permission-mode',
      'default',
      '--chrome',
      '--settings',
      expect.any(String),
    ]);
    expect(args).not.toContain('-p');
    const settings = JSON.parse(readFileSync(args.at(-1)!, 'utf8'));
    for (const event of ['PermissionRequest', 'Stop', 'Notification', 'SessionStart', 'UserPromptSubmit']) {
      const command: string = settings.hooks[event][0].hooks[0].command;
      expect(command).toContain(`http://127.0.0.1:9/hook/${SESSION}/${event}`);
    }
    expect(settings.hooks.PermissionRequest[0].hooks[0].timeout).toBeGreaterThan(3600);
    // The statusline is how an interactive session reports cost and context (code.claude.com/docs/en/statusline).
    expect(settings.statusLine).toMatchObject({ type: 'command' });
    expect(settings.statusLine.command).toContain(`http://127.0.0.1:9/hook/${SESSION}/StatusLine`);
    expect(options.env).toMatchObject({ CRYSTAL_SESSION: SESSION, CLAUDE_CONFIG_DIR: '/cfg', TERM: 'xterm-256color' });
    expect(options.env).not.toHaveProperty('CLAUDECODE');
    expect(options.env).not.toHaveProperty('CLAUDE_CODE_SESSION_ID');
    expect(options.env).not.toHaveProperty('CRYSTAL_TOKEN');
    expect(options.env).toHaveProperty('CLAUDE_CODE_MAX_OUTPUT_TOKENS', '64000');
  });

  it('types the first prompt once the session has started, as a bracketed paste then Enter', async () => {
    const { session, spawned, hook } = harness();
    session.start('hello there');
    const pty = spawned[0]!.pty;
    expect(pty.written).toEqual([]);
    hook('SessionStart', { source: 'startup' });
    await tick();
    expect(pty.written.join('')).toBe('\x1b[200~hello there\x1b[201~\r');
  });

  it('accepts the workspace-trust dialog once: the cursor starts on "No, exit"', async () => {
    const { session, spawned } = harness();
    session.start('hello');
    const pty = spawned[0]!.pty;
    pty.emitData('Quick safety check \x1b[1m❯ No, exit\x1b[0m\r\n  Yes, I trust this folder\r\n');
    await tick(900);
    expect(pty.written.join('')).toBe('\x1b[B\r');
    pty.emitData('Yes, I trust this folder');
    await tick(900);
    expect(pty.written.join('')).toBe('\x1b[B\r');
  });

  it('holds the turn result until the reply the Stop hook names has come through the transcript', async () => {
    const { session, events, hook, line } = harness();
    session.start('hello');
    hook('SessionStart', {});
    await tick();
    // The CLI runs Stop before it writes the reply's last text block to the transcript.
    hook('Stop', { last_assistant_message: 'All done.', background_tasks: [] });
    await tick();
    expect(events.some((e) => e.type === 'turn.finished')).toBe(false);
    line(assistant('m1', [{ type: 'text', text: 'All done.' }]));
    await tick();
    const kinds = events.map((e) =>
      e.type === 'claude.event' ? (e.payload as { raw: { type: string } }).raw.type : e.type,
    );
    expect(kinds.slice(-3)).toEqual(['assistant', 'result', 'turn.finished']);
  });

  it('gives up waiting for the reply after a moment, so a turn always finishes', async () => {
    const { session, events, hook } = harness({ stopWaitMs: 50 });
    session.start('hello');
    hook('SessionStart', {});
    await tick();
    hook('Stop', { last_assistant_message: 'never written', background_tasks: [] });
    await tick(120);
    expect(events.at(-1)).toMatchObject({ type: 'turn.finished', payload: { outcome: 'success' } });
  });

  it('streams new transcript lines as claude events and ends the turn on the Stop hook', async () => {
    const { session, events, hook, line } = harness();
    session.start('hello');
    hook('SessionStart', { source: 'startup', model: 'some-model' });
    await tick();
    expect(session.busy).toBe(true);
    expect(events[0]).toMatchObject({
      type: 'claude.event',
      payload: { raw: { type: 'system', subtype: 'init', permissionMode: 'default' } },
    });

    line({ type: 'user', message: { role: 'user', content: 'hello' } });
    line(assistant('m1', [{ type: 'text', text: 'Hi!' }]));
    line({ type: 'cost-state', totalCostUSD: 0.25 });
    await tick();
    expect(
      events.filter((e) => e.type === 'claude.event').map((e) => (e.payload as { raw: { type: string } }).raw.type),
    ).toEqual(['system', 'assistant']);

    hook('Stop', { last_assistant_message: 'Hi!', background_tasks: [] });
    await tick();
    expect(events.at(-2)).toMatchObject({
      type: 'claude.event',
      payload: { raw: { type: 'result', subtype: 'success', result: 'Hi!', total_cost_usd: 0.25 } },
    });
    expect(events.at(-1)).toMatchObject({
      type: 'turn.finished',
      payload: { outcome: 'success', summary: 'Hi!', costUsd: 0.25 },
    });
    expect(session.busy).toBe(false);
  });

  it('is not held busy by passive monitors (e.g. live watches), only by work like subagents and shells', async () => {
    const { session, hook } = harness();
    session.start('hello');
    hook('SessionStart', { source: 'startup' });
    hook('Stop', {
      last_assistant_message: 'done',
      background_tasks: [
        { id: 'w1', type: 'monitor', status: 'running', server: 'artifacts' },
        { id: 'w2', type: 'monitor', status: 'running' },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect(session.busy).toBe(false);
    hook('Stop', {
      last_assistant_message: 'working',
      background_tasks: [{ id: 'a1', type: 'subagent', status: 'running' }],
    });
    expect(session.busy).toBe(true);
  });

  it('is not held busy by background tasks the Stop hook reports as finished', async () => {
    const { session, hook } = harness();
    session.start('hello');
    hook('SessionStart', { source: 'startup' });
    hook('Stop', {
      last_assistant_message: 'done',
      background_tasks: [
        { id: 'a1', type: 'subagent', status: 'completed' },
        { id: 'a2', type: 'subagent', status: 'failed' },
        { id: 's1', type: 'shell', status: 'killed' },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect(session.busy).toBe(false);
    hook('Stop', {
      last_assistant_message: 'watching',
      background_tasks: [{ id: 's1', type: 'shell', status: 'running' }],
    });
    expect(session.busy).toBe(true);
  });

  it('stays busy while the Stop hook reports background tasks', async () => {
    const { session, hook } = harness();
    session.start('hello');
    hook('SessionStart', {});
    hook('Stop', { last_assistant_message: 'watching', background_tasks: [{ id: 'b1' }] });
    await tick();
    expect(session.busy).toBe(true);
  });

  it('types follow-ups into the live session, and resumes with --resume once it has exited', async () => {
    const { session, spawned, events, hook } = harness();
    session.start('hello');
    hook('SessionStart', {});
    await tick();
    session.send('more');
    expect(spawned[0]!.pty.written.at(-1)).toBe('\r');
    expect(spawned[0]!.pty.written.join('')).toContain('\x1b[200~more\x1b[201~');

    spawned[0]!.pty.emitExit(0);
    await tick();
    expect(events.at(-1)).toEqual({ type: 'session.ended', payload: { exitCode: 0, signal: null, reason: 'exit' } });
    session.send('again');
    expect(spawned[1]!.args.slice(0, 2)).toEqual(['--resume', SESSION]);
    expect(events.at(-1)).toEqual({ type: 'session.resumed', payload: {} });
    hook('SessionStart', { source: 'resume' });
    await tick();
    expect(spawned[1]!.pty.written.join('')).toBe('\x1b[200~again\x1b[201~\r');
  });

  it('restarts the terminal and types the message again when it never takes a typed follow-up', async () => {
    // A terminal-only screen (e.g. a dialog shown after a long idle) can swallow typed text: nothing is submitted.
    const { session, spawned, events, hook } = harness({ submitWaitMs: 30 });
    session.start('hello');
    hook('SessionStart', {});
    await tick(10);
    hook('UserPromptSubmit', { prompt: 'hello' });
    hook('Stop', { last_assistant_message: '' });
    await tick();
    expect(session.busy).toBe(false);

    session.send('are you there?');
    await tick(80);
    expect(spawned[0]!.pty.killed).toEqual(['SIGTERM']);
    spawned[0]!.pty.emitExit(143);
    await tick();
    expect(spawned[1]!.args.slice(0, 2)).toEqual(['--resume', SESSION]);
    expect(events.at(-1)).toEqual({ type: 'session.resumed', payload: {} });
    expect(events.filter((e) => e.type === 'error' || e.type === 'session.ended')).toEqual([]);
    expect(session.busy).toBe(true);

    hook('SessionStart', { source: 'resume' });
    await tick(10);
    expect(spawned[1]!.pty.written.join('')).toBe('\x1b[200~are you there?\x1b[201~\r');
    hook('UserPromptSubmit', { prompt: 'are you there?' });
    await tick(80);
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(session.busy).toBe(true);
  });

  it('counts a typed message as taken once the transcript records it, with or without UserPromptSubmit', async () => {
    // A `!` shell command fires no UserPromptSubmit, but the CLI still records it and may start a turn.
    const { session, spawned, events, hook, line } = harness({ submitWaitMs: 60 });
    session.start('hello');
    hook('SessionStart', {});
    await tick(10);
    hook('UserPromptSubmit', { prompt: 'hello' });
    hook('Stop', { last_assistant_message: '' });
    await tick();

    const before = events.length;
    session.send('! git status');
    line({ type: 'user', message: { role: 'user', content: '<bash-input>git status</bash-input>' } });
    await tick(120);
    expect(spawned[0]!.pty.killed).toEqual([]);
    expect(events.slice(before).filter((e) => e.type === 'error' || e.type === 'turn.finished')).toEqual([]);
    expect(session.busy).toBe(true);
  });

  it('dismisses a dialog that offers Esc and types the message again before restarting anything', async () => {
    // Seen live: a long conversation's autocompact offer ("enter confirm · esc not now") swallows typed text.
    const { session, spawned, events, hook } = harness({ submitWaitMs: 30, dialogSettleMs: 5 });
    session.start('hello');
    hook('SessionStart', {});
    await tick(10);
    hook('UserPromptSubmit', { prompt: 'hello' });
    hook('Stop', { last_assistant_message: '' });
    await tick();

    spawned[0]!.pty.emitData(
      'Want to change a setting?\r\n  Keep it\r\n  Change it\r\n↑/↓ choose · enter confirm · esc not now',
    );
    session.send('are you there?');
    const typed = spawned[0]!.pty.written.length;
    await tick(60);
    expect(spawned[0]!.pty.killed).toEqual([]);
    expect(spawned[0]!.pty.written.slice(typed)).toEqual(['\x1b', '\x1b[200~are you there?\x1b[201~', '\r']);
    hook('UserPromptSubmit', { prompt: 'are you there?' });
    await tick(60);
    expect(spawned).toHaveLength(1);
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(session.busy).toBe(true);
  });

  it('asks through the app when the restarted terminal also never takes it, then gives up if nobody answers', async () => {
    const { session, spawned, events, hook } = harness({ submitWaitMs: 30, terminalWaitMs: 40 });
    session.start('hello');
    hook('SessionStart', {});
    await tick(10);
    hook('UserPromptSubmit', { prompt: 'hello' });
    hook('Stop', { last_assistant_message: '' });
    await tick();

    session.send('are you there?');
    await tick(80);
    spawned[0]!.pty.emitExit(143);
    hook('SessionStart', { source: 'resume' });
    spawned[1]!.pty.emitData('Some earlier output\r\n\r\n  A dialog the bridge cannot see\r\n  1. Yes  2. No\r\n');
    await tick(50);
    expect(events.find((e) => e.type === 'terminal.screen')?.payload).toEqual({
      open: true,
      raised: true,
      held: true,
      text: expect.stringContaining('A dialog the bridge cannot see'),
    });
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(session.busy).toBe(true);
    await tick(60);
    expect(spawned[1]!.pty.killed).toEqual([]);
    const error = events.find((e) => e.type === 'error');
    expect(error?.payload).toEqual({
      message: expect.stringContaining('A dialog the bridge cannot see\n1. Yes  2. No'),
    });
    expect(events.at(-1)).toEqual({ type: 'turn.finished', payload: { outcome: 'error' } });
    expect(session.busy).toBe(false);
  });

  it('only reports a message the terminal never takes while background work would die with a restart', async () => {
    const { session, spawned, events, hook } = harness({ submitWaitMs: 30, terminalWaitMs: 10 });
    session.start('hello');
    hook('SessionStart', {});
    await tick(10);
    hook('UserPromptSubmit', { prompt: 'hello' });
    hook('Stop', { last_assistant_message: '', background_tasks: [{ type: 'subagent', status: 'running' }] });
    await tick();

    session.send('are you there?');
    await tick(100);
    expect(spawned[0]!.pty.killed).toEqual([]);
    expect(events.at(-2)).toMatchObject({ type: 'error', payload: { message: expect.stringContaining('terminal') } });
    expect(events.at(-1)).toEqual({ type: 'turn.finished', payload: { outcome: 'error' } });
  });

  it('says why it counts as busy: a message not yet taken, a turn open, or background work', async () => {
    const { session, hook } = harness({ submitWaitMs: 10_000 });
    expect(session.busyReason).toBeUndefined();
    session.start('hello');
    hook('SessionStart', {});
    await until(() => session.busyReason?.startsWith('typed') === true);
    expect(session.busyReason).toMatch(/^typed message not yet taken for \d+s$/);
    hook('UserPromptSubmit', { prompt: 'hello' });
    expect(session.busyReason).toMatch(/^turn open for \d+s$/);
    hook('Stop', { last_assistant_message: '', background_tasks: [{ type: 'shell', status: 'running' }] });
    await tick();
    expect(session.busyReason).toBe('background tasks running');
  });

  describe('changing effort', () => {
    async function afterATurn(overrides: Parameters<typeof harness>[0] = {}) {
      const test = harness({ effort: 'high', ...overrides });
      test.session.start('hello');
      test.hook('SessionStart', {});
      await tick(10);
      test.hook('UserPromptSubmit', { prompt: 'hello' });
      return test;
    }
    const finish = async ({ hook }: ReturnType<typeof harness>, extra = {}) => {
      hook('Stop', { last_assistant_message: '', ...extra });
      await tick(5);
    };

    it('moves the next message to a new process with the new effort, typing it there', async () => {
      const test = await afterATurn({ stopWaitMs: 1 });
      const { session, spawned, hook, events } = test;
      await finish(test);
      session.setEffort('low');
      expect(spawned[0]!.pty.killed).toEqual([]);

      session.send('next');
      expect(spawned[0]!.pty.killed).toEqual(['SIGTERM']);
      spawned[0]!.pty.emitExit(143);
      expect(spawned[1]!.args).toEqual(expect.arrayContaining(['--resume', '--effort', 'low']));
      expect(events.find((e) => e.type === 'session.ended')).toBeUndefined();
      hook('SessionStart', { source: 'resume' });
      await tick(10);
      expect(spawned[1]!.pty.written).toContain('\x1b[200~next\x1b[201~');
    });

    it('leaves a turn that’s running alone, and keeps a process for an unchanged choice', async () => {
      const test = await afterATurn({ stopWaitMs: 1 });
      const { session, spawned } = test;
      session.setEffort('low');
      session.send('while it works');
      expect(spawned[0]!.pty.killed).toEqual([]);
      session.setEffort('high');
      await finish(test);
      session.send('after');
      expect(spawned[0]!.pty.killed).toEqual([]);
    });

    it('leaves a process holding background work alone', async () => {
      const test = await afterATurn({ stopWaitMs: 1 });
      await finish(test, { background_tasks: [{ type: 'subagent', status: 'running' }] });
      test.session.setEffort('low');
      test.session.send('next');
      expect(test.spawned[0]!.pty.killed).toEqual([]);
    });
  });

  describe('asking through the app', () => {
    /** A terminal that swallowed a follow-up and so is asking, after its restart. */
    async function asking(overrides: Parameters<typeof harness>[0] = {}) {
      const test = harness({ submitWaitMs: 20, screenUpdateMs: 5, ...overrides });
      const { session, spawned, hook } = test;
      session.start('hello');
      hook('SessionStart', {});
      await tick(10);
      hook('UserPromptSubmit', { prompt: 'hello' });
      hook('Stop', { last_assistant_message: '', background_tasks: [{ type: 'subagent', status: 'running' }] });
      await tick();
      session.send('are you there?');
      spawned[0]!.pty.emitData('  Pick a theme\r\n  1. Light  2. Dark\r\n');
      await tick(40);
      return test;
    }
    const screens = (events: { type: string; payload: unknown }[]) =>
      events.filter((e) => e.type === 'terminal.screen').map((e) => e.payload as Record<string, unknown>);

    it('follows the screen, only when it changes', async () => {
      const { spawned, events } = await asking();
      expect(screens(events)).toHaveLength(1);
      spawned[0]!.pty.emitData('\x1b[2J\x1b[H  Pick a colour\r\n');
      await tick(20);
      expect(screens(events).at(-1)).toEqual({ open: true, text: expect.stringContaining('Pick a colour') });
      await tick(20);
      expect(screens(events)).toHaveLength(2);
    });

    it('sends keys to the terminal, and keeps waiting while someone answers', async () => {
      const { session, spawned, events } = await asking({ terminalWaitMs: 300 });
      const written = spawned[0]!.pty.written.length;
      await tick(200);
      session.keys({ keys: '2' });
      expect(spawned[0]!.pty.written.slice(written)).toEqual(['2']);
      await tick(200);
      expect(events.find((e) => e.type === 'error')).toBeUndefined();
      expect(session.busy).toBe(true);
    });

    it('types the held message again when asked, and closes once the CLI takes it', async () => {
      const { session, spawned, events, hook } = await asking();
      const written = spawned[0]!.pty.written.length;
      session.keys({ retype: true });
      expect(spawned[0]!.pty.written.slice(written)).toEqual(['\x1b[200~are you there?\x1b[201~', '\r']);
      hook('UserPromptSubmit', { prompt: 'are you there?' });
      expect(screens(events).at(-1)).toEqual({ open: false });
      expect(session.busyReason).toMatch(/^turn open/);
    });

    it('takes no keys unless it is asking: this is not a way to type into a Quest', () => {
      const { session, spawned, events, hook } = harness();
      session.start('hello');
      hook('SessionStart', {});
      const written = spawned[0]!.pty.written.length;
      session.keys({ keys: 'rm -rf /\r' });
      expect(spawned[0]!.pty.written.length).toBe(written);
      expect(events.at(-1)?.type).toBe('error');
    });

    it('closes on Stop, and says why the Quest is busy until then', async () => {
      const { session, events } = await asking();
      expect(session.busyReason).toMatch(/^its terminal is asking something/);
      session.interrupt();
      expect(screens(events).at(-1)).toEqual({ open: false });
    });

    it('closes when the process exits', async () => {
      const { spawned, events } = await asking();
      spawned[0]!.pty.emitExit(0);
      expect(screens(events).at(-1)).toEqual({ open: false });
    });

    it('asks when a start never reaches the input box, and types the prompt once it does', async () => {
      const { session, spawned, events, hook } = harness({ startWaitMs: 15, screenUpdateMs: 5 });
      session.start('hello');
      spawned[0]!.pty.emitData('  Sign in to continue\r\n');
      await tick(30);
      expect(screens(events)[0]).toEqual({
        open: true,
        raised: true,
        held: false,
        text: expect.stringContaining('Sign in to continue'),
      });
      session.keys({ keys: '\r' });
      hook('SessionStart', {});
      await tick(10);
      expect(screens(events).at(-1)).toEqual({ open: false });
      expect(spawned[0]!.pty.written).toContain('\x1b[200~hello\x1b[201~');
    });

    it('stops a start nobody answered, so the next message can begin again', async () => {
      const { spawned, events, session } = harness({ startWaitMs: 5, terminalWaitMs: 10 });
      session.start('hello');
      await tick(40);
      expect(events.at(-1)).toEqual({ type: 'turn.finished', payload: { outcome: 'error' } });
      expect(spawned[0]!.pty.killed).toEqual(['SIGTERM']);
    });

    it('does not ask about a start that reached the input box in time', async () => {
      const { events, hook, session } = harness({ startWaitMs: 15 });
      session.start('hello');
      hook('SessionStart', {});
      await tick(30);
      expect(screens(events)).toEqual([]);
    });
  });

  it('keeps the turn once the CLI takes the typed prompt', async () => {
    const { session, events, hook } = harness({ submitWaitMs: 60 });
    session.start('hello');
    hook('SessionStart', {});
    await tick(10);
    hook('UserPromptSubmit', { prompt: 'hello' });
    await tick(100);
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(session.busy).toBe(true);
  });

  it('interrupts with Esc and reports the turn as interrupted', async () => {
    const { session, spawned, events, hook } = harness();
    session.start('hello');
    hook('SessionStart', {});
    await tick();
    session.interrupt();
    expect(spawned[0]!.pty.written.at(-1)).toBe('\x1b');
    expect(events.at(-1)).toEqual({
      type: 'turn.finished',
      payload: { outcome: 'interrupted', durationMs: expect.any(Number) },
    });
    expect(session.busy).toBe(false);
  });

  it('shows a prompt the CLI says only its terminal has, for as long as it stays open', async () => {
    const { session, spawned, events, hook } = harness({ terminalWaitMs: 5 });
    session.start('hello');
    hook('SessionStart', {});
    await tick(5);
    hook('UserPromptSubmit', { prompt: 'hello' });
    spawned[0]!.pty.emitData('  Pick one\r\n');
    await tick(30);
    hook('Notification', { notification_type: 'elicitation_dialog', message: 'Pick one' });
    expect(events.at(-1)).toEqual({
      type: 'terminal.screen',
      payload: { open: true, raised: true, held: false, text: expect.stringContaining('Pick one') },
    });
    // It can wait on a person like an approval does, so nothing gives up on it.
    await tick(30);
    expect(session.busy).toBe(true);
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    hook('Stop', { last_assistant_message: '' });
    expect(events.filter((e) => e.type === 'terminal.screen').at(-1)?.payload).toEqual({ open: false });
  });

  it('closes with /exit, then a signal if it lingers', async () => {
    const { session, spawned, hook } = harness({ closeGraceMs: 20 });
    session.start('hello');
    hook('SessionStart', {});
    await tick();
    session.close();
    expect(spawned[0]!.pty.written.join('')).toContain('/exit');
    await tick(60);
    expect(spawned[0]!.pty.killed).toEqual(['SIGTERM']);
  });
});

describe('InteractiveSession stats and inventory', () => {
  const status = (over: Record<string, unknown> = {}) => ({
    session_id: SESSION,
    cost: { total_cost_usd: 0.5, total_duration_ms: 9000, total_api_duration_ms: 4000 },
    context_window: { context_window_size: 200000, total_input_tokens: 30000, used_percentage: 15 },
    ...over,
  });
  const withUsage = (id: string, text: string, usage: Record<string, number>) => ({
    type: 'assistant',
    isSidechain: false,
    message: { id, role: 'assistant', content: [{ type: 'text', text }], usage },
  });

  it('announces the context window as soon as the statusline reports it, once per size', async () => {
    const { session, events, hook } = harness();
    session.start('hello');
    hook('SessionStart', { source: 'startup' });
    hook('StatusLine', status());
    hook('StatusLine', status());
    hook('StatusLine', status({ context_window: { context_window_size: 1000000 } }));
    await tick();
    const announced = events.flatMap((e) => {
      if (e.type !== 'claude.event') return [];
      const raw = e.payload.raw as { subtype?: string; contextWindow?: number };
      return raw.subtype === 'context_window' ? [raw.contextWindow] : [];
    });
    expect(announced).toEqual([200000, 1000000]);
  });

  it('announces where the Quest compacts along with the window, for the model the statusline names', async () => {
    const asked: Array<string | undefined> = [];
    const { session, events, hook } = harness({
      compactWindow: (model) => {
        asked.push(model);
        return 800000;
      },
    });
    session.start('hello');
    hook('SessionStart', { source: 'startup' });
    hook('StatusLine', status({ model: { id: 'model-x' } }));
    hook('StatusLine', status({ model: { id: 'model-x' } }));
    await tick();
    const lines = events.flatMap((e) => {
      if (e.type !== 'claude.event') return [];
      const raw = e.payload.raw as { subtype?: string };
      return raw.subtype === 'context_window' ? [raw] : [];
    });
    expect(lines).toEqual([
      { type: 'system', subtype: 'context_window', contextWindow: 200000, compactWindow: 800000 },
    ]);
    expect(asked).toEqual(['model-x']);
  });

  it('times the whole turn, tool time included, not the API time the statusline reports', async () => {
    const { session, events, hook, line } = harness();
    session.start('hello');
    hook('SessionStart', { source: 'startup' });
    hook('StatusLine', status({ cost: { total_cost_usd: 0.1, total_api_duration_ms: 1 } }));
    await tick(120);
    line(withUsage('m1', 'Done', { output_tokens: 1 }));
    hook('StatusLine', status({ cost: { total_cost_usd: 0.1, total_api_duration_ms: 2 } }));
    hook('Stop', { last_assistant_message: 'Done', background_tasks: [] });
    await tick();
    const finished = events.find((e) => e.type === 'turn.finished')!.payload as { durationMs: number };
    expect(finished.durationMs).toBeGreaterThanOrEqual(100);
    const raw = events.flatMap((e) => (e.type === 'claude.event' ? [e.payload.raw as Record<string, unknown>] : []));
    expect(raw.find((r) => r.type === 'result')).toMatchObject({ duration_ms: finished.durationMs });
  });

  it('times a stopped turn too', async () => {
    const { session, events, hook } = harness();
    session.start('hello');
    hook('SessionStart', { source: 'startup' });
    await tick();
    session.interrupt();
    expect(events.find((e) => e.type === 'turn.finished')).toMatchObject({
      payload: { outcome: 'interrupted', durationMs: expect.any(Number) },
    });
  });

  it('waits briefly for the statusline after a reply, whose last request it may not have counted yet', async () => {
    const { session, events, hook, line } = harness({ costSettleMs: 500 });
    session.start('hello');
    hook('SessionStart', { source: 'startup' });
    hook('StatusLine', status({ cost: { total_cost_usd: 1 } }));
    await tick();
    line(withUsage('m1', 'Done', { output_tokens: 1 }));
    hook('Stop', { last_assistant_message: 'Done', background_tasks: [] });
    await tick();
    expect(events.some((e) => e.type === 'turn.finished')).toBe(false);
    hook('StatusLine', status({ cost: { total_cost_usd: 1.3 } }));
    await tick();
    const raw = events.flatMap((e) => (e.type === 'claude.event' ? [e.payload.raw as Record<string, unknown>] : []));
    expect(raw.find((r) => r.type === 'result')).toMatchObject({ total_cost_usd: 1.3 });
  });

  it('ends the turn anyway when no later statusline comes', async () => {
    const { session, events, hook, line } = harness({ costSettleMs: 30 });
    session.start('hello');
    hook('SessionStart', { source: 'startup' });
    await tick();
    line(withUsage('m1', 'Done', { output_tokens: 1 }));
    hook('Stop', { last_assistant_message: 'Done', background_tasks: [] });
    await tick(120);
    expect(events.some((e) => e.type === 'turn.finished')).toBe(true);
  });

  it('reports the files the turn changed, once the tracker has them', async () => {
    const begun: string[] = [];
    const { session, events, hook, line } = harness({
      changes: {
        begin: async () => void begun.push('begin'),
        finish: async () => ['a.ts'],
      },
    });
    session.start('hello');
    hook('SessionStart', { source: 'startup' });
    await tick();
    session.send('while it runs');
    line(withUsage('m1', 'Done', { output_tokens: 1 }));
    hook('Stop', { last_assistant_message: 'Done', background_tasks: [] });
    await tick();
    expect(begun).toEqual(['begin']);
    expect(events.findIndex((e) => e.type === 'turn.finished')).toBeLessThan(events.length - 1);
    expect(events.at(-1)).toMatchObject({
      type: 'claude.event',
      payload: { raw: { type: 'system', subtype: 'turn_changes', files: ['a.ts'] } },
    });
  });

  it('gives each turn result the cost, its own tokens once per message, its API time and the context window', async () => {
    const { session, events, hook, line } = harness();
    session.start('hello');
    hook('SessionStart', { source: 'startup' });
    hook('StatusLine', status({ cost: { total_cost_usd: 0.1, total_api_duration_ms: 1000 } }));
    await tick();
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 };
    // One message written as two lines (one per content block) repeats its usage: count it once.
    line(withUsage('m1', 'Hi', usage));
    line(withUsage('m1', '!', usage));
    line(withUsage('m2', 'Done', usage));
    hook('StatusLine', status());
    await tick();
    hook('Stop', { last_assistant_message: 'Done', background_tasks: [] });
    await tick();
    const result = events.find(
      (e) => e.type === 'claude.event' && (e.payload as { raw: { type: string } }).raw.type === 'result',
    );
    expect(result).toMatchObject({
      payload: {
        raw: {
          type: 'result',
          total_cost_usd: 0.5,
          usage: { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 40 },
          modelUsage: { session: { contextWindow: 200000 } },
        },
      },
    });
    // The engine-neutral turn.finished carries the turn's own share: cost and time since the turn began.
    const finished = events.find((e) => e.type === 'turn.finished')!.payload as unknown as Record<string, unknown>;
    expect(finished.costUsd).toBeCloseTo(0.4);
    expect(finished).toMatchObject({
      tokens: { input: 20, output: 10, cacheRead: 200, cacheWrite: 40 },
    });
  });

  it('reports plan usage from the statusline as a usage event, only when it changes', async () => {
    const { session, events, hook } = harness();
    session.start('hello');
    const limits = {
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: 1800000000 },
        seven_day: { used_percentage: 41.2 },
      },
    };
    hook('StatusLine', status(limits));
    hook('StatusLine', status(limits));
    await tick();
    const usage = events.filter((e) => e.type === 'usage');
    expect(usage).toHaveLength(1);
    expect(usage[0]!.payload).toEqual({
      windows: [
        { id: 'five_hour', label: '5h', usedPct: 23.5, resetsAt: 1800000000000, status: 'unknown' },
        { id: 'seven_day', label: '7d', usedPct: 41.2, resetsAt: null, status: 'unknown' },
      ],
    });
  });

  it('lists skills and MCP servers from the transcript as an init line the Inventory reads, including earlier ones', async () => {
    const { session, events, hook, line } = harness();
    // Written before the session reports in, like a resumed session's listing: still picked up.
    line({ type: 'attachment', attachment: { type: 'skill_listing', names: ['review', 'plugin:deploy'] } });
    session.start('hello');
    hook('SessionStart', { source: 'startup' });
    await tick();
    line({
      type: 'attachment',
      attachment: {
        type: 'deferred_tools_delta',
        addedNames: [
          'mcp__github__list_issues',
          'mcp__github__get_issue',
          'mcp__claude_ai_Gmail__search',
          // A server waiting on sign-in offers only its sign-in tools.
          'mcp__locked__authenticate',
          'mcp__locked__complete_authentication',
          'WebFetch',
        ],
        removedNames: [],
        pendingMcpServers: ['slow'],
        failedMcpServers: ['broken'],
      },
    });
    await tick();
    const inits = events
      .filter((e) => e.type === 'claude.event')
      .map((e) => (e.payload as { raw: Record<string, unknown> }).raw)
      .filter((raw) => raw.type === 'system' && raw.subtype === 'init');
    expect(inits.at(-1)).toMatchObject({
      skills: ['review', 'plugin:deploy'],
      slash_commands: ['review', 'plugin:deploy'],
      mcp_servers: [
        { name: 'broken', status: 'failed' },
        { name: 'claude.ai Gmail', status: 'connected' },
        { name: 'github', status: 'connected' },
        { name: 'locked', status: 'needs-auth' },
        { name: 'slow', status: 'pending' },
      ],
    });
  });

  it('passes --effort when the session has one, on every process it starts (resumes too)', async () => {
    const { session, spawned, hook } = harness({ effort: 'max' });
    session.start('hello');
    hook('SessionStart', {});
    await tick();
    spawned[0]!.pty.emitExit(0);
    await tick();
    session.send('again');
    for (const { args } of [spawned[0]!, spawned[1]!]) expect(args[args.indexOf('--effort') + 1]).toBe('max');
  });

  it('gives every process it starts the extra folders it may read (--add-dir, one each)', async () => {
    const { session, spawned, hook } = harness({ addDirs: ['/tmp/files/s1'] });
    session.start('hello');
    hook('SessionStart', {});
    await tick();
    const { args } = spawned[0]!;
    expect(args[args.indexOf('--add-dir') + 1]).toBe('/tmp/files/s1');
    expect(args[args.indexOf('--add-dir') + 2]).toMatch(/^--/);
  });
});
