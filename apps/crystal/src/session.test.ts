import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { spawn as nodeSpawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeSession, type ClaudeSessionEvent } from './session.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

function readFixtureLines(name: string): string[] {
  return readFileSync(join(FIXTURES, `${name}.ndjson`), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
}

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: Writable & { writes: string[] };
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killSignals: NodeJS.Signals[];
  kill(signal?: NodeJS.Signals): boolean;
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  const writes: string[] = [];
  const stdin = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      writes.push(chunk.toString());
      callback();
    },
  }) as FakeChild['stdin'];
  stdin.writes = writes;
  child.stdin = stdin;

  child.exitCode = null;
  child.signalCode = null;
  child.killSignals = [];
  child.kill = (signal) => {
    const sig = signal ?? 'SIGTERM';
    child.killSignals.push(sig);
    child.signalCode = sig;
    // Real Node fires 'exit' then 'close'; ClaudeSession only reacts to 'close'.
    child.emit('exit', null, sig);
    child.emit('close', null, sig);
    return true;
  };
  return child;
}

/** A fake child whose stdin always fails to write, like a dead process raising EPIPE. */
function createFakeChildWithFailingStdin(): FakeChild {
  const child = createFakeChild();
  const failingStdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error('write EPIPE'));
    },
  }) as FakeChild['stdin'];
  failingStdin.writes = [];
  child.stdin = failingStdin;
  return child;
}

interface SpawnCall {
  command: string;
  args: string[];
  options: Record<string, unknown>;
}

function createSpawnMock(): { spawnFn: typeof nodeSpawn; calls: SpawnCall[]; children: FakeChild[] } {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const spawnFn = ((command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    const child = createFakeChild();
    children.push(child);
    return child;
  }) as unknown as typeof nodeSpawn;
  return { spawnFn, calls, children };
}

function createSpawnMockWithFailingStdin(): { spawnFn: typeof nodeSpawn; children: FakeChild[] } {
  const children: FakeChild[] = [];
  const spawnFn = (() => {
    const child = createFakeChildWithFailingStdin();
    children.push(child);
    return child;
  }) as unknown as typeof nodeSpawn;
  return { spawnFn, children };
}

/** Let pending stream 'data' events (and any other queued microtasks) drain. */
async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function finishExit(child: FakeChild, code: number | null, signal: NodeJS.Signals | null = null): void {
  child.exitCode = code;
  child.signalCode = signal;
  // Real Node fires 'exit' then 'close'; ClaudeSession only reacts to 'close'.
  child.emit('exit', code, signal);
  child.emit('close', code, signal);
}

const SESSION_ID = '11111111-1111-1111-1111-111111111111';
// Must exist: a spawn error with a missing cwd is reported differently.
const CWD = tmpdir();
const PERMISSION_URL = `http://127.0.0.1:9999/mcp/${SESSION_ID}`;

function createSession(
  spawnFn: typeof nodeSpawn,
  overrides: Partial<{
    claudeBin: string;
    idleMs: number;
    cwd: string;
    permissionMode: 'manual' | 'acceptEdits' | 'auto' | 'plan';
    forkFrom: string;
    chrome: boolean;
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  }> = {},
) {
  return new ClaudeSession({
    session: SESSION_ID,
    cwd: CWD,
    permissionUrl: PERMISSION_URL,
    spawn: spawnFn,
    ...overrides,
  });
}

function collect(session: ClaudeSession): ClaudeSessionEvent[] {
  const events: ClaudeSessionEvent[] = [];
  session.on('event', (event: ClaudeSessionEvent) => events.push(event));
  return events;
}

describe('ClaudeSession', () => {
  afterEach(() => {
    delete process.env.CLAUDE_BIN;
  });

  it('spawns the first child with the Task 5 flags, and never --bare', () => {
    const { spawnFn, calls } = createSpawnMock();
    const session = createSession(spawnFn);

    session.start('hello');

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.command).toBe('claude');
    expect(call.args).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--mcp-config',
      JSON.stringify({ mcpServers: { crystal: { type: 'http', url: PERMISSION_URL } } }),
      '--permission-prompt-tool',
      'mcp__crystal__approve',
      '--permission-mode',
      'manual',
      '--session-id',
      SESSION_ID,
    ]);
    expect(call.args).not.toContain('--bare');
    expect(call.options.cwd).toBe(CWD);
    expect(call.options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });

  it('starts a fork from another conversation under its own id, then resumes its own id', () => {
    const { spawnFn, calls, children } = createSpawnMock();
    const source = '11111111-2222-4333-8444-555555555555';
    const session = createSession(spawnFn, { forkFrom: source });

    session.start('try another way');

    expect(calls[0]!.args.slice(-5)).toEqual(['--resume', source, '--fork-session', '--session-id', SESSION_ID]);
    finishExit(children[0]!, 0);
    session.send('more');
    expect(calls[1]!.args.slice(-2)).toEqual(['--resume', SESSION_ID]);
    expect(calls[1]!.args).not.toContain('--fork-session');
  });

  it('passes --effort when the session has one, on every process it starts (resumes too)', async () => {
    const { spawnFn, calls, children } = createSpawnMock();
    createSession(spawnFn).start('hello');
    expect(calls[0]!.args).not.toContain('--effort');

    const session = createSession(spawnFn, { effort: 'high' });
    session.start('hello');
    finishExit(children[1]!, 0);
    session.send('more');
    for (const call of [calls[1]!, calls[2]!]) {
      expect(call.args[call.args.indexOf('--effort') + 1]).toBe('high');
    }
  });

  it('adds --chrome only when the node enables it, on every process it starts', async () => {
    const { spawnFn, calls, children } = createSpawnMock();
    createSession(spawnFn).start('hello');
    expect(calls[0]!.args).not.toContain('--chrome');

    const session = createSession(spawnFn, { chrome: true });
    session.start('hello');
    finishExit(children[1]!, 0);
    session.send('more');
    expect(calls[1]!.args).toContain('--chrome');
    expect(calls[2]!.args).toContain('--chrome');
  });

  it('defaults claudeBin to CLAUDE_BIN, falling back to "claude"', () => {
    process.env.CLAUDE_BIN = 'claude-from-env';
    const { spawnFn, calls } = createSpawnMock();
    const session = createSession(spawnFn);

    session.start('hello');

    expect(calls[0]!.command).toBe('claude-from-env');
  });

  it('replays allow.ndjson as one claude.event per line, with raw equal to the parsed line, in order', async () => {
    const { spawnFn, children } = createSpawnMock();
    const session = createSession(spawnFn);
    const events = collect(session);

    session.start('touch crystal.txt, then say DONE');
    const child = children[0]!;
    const lines = readFixtureLines('allow');
    for (const line of lines) child.stdout.write(`${line}\n`);
    await flush();

    // The fixture's rate_limit_event and result lines are also followed by derived usage and turn.finished events.
    const claudeEvents = events.filter((event) => event.type === 'claude.event');
    expect(claudeEvents).toHaveLength(lines.length);
    for (const [i, event] of claudeEvents.entries()) {
      expect(event.payload).toEqual({ engine: 'claude', raw: JSON.parse(lines[i]!) });
    }
    expect(events.filter((event) => event.type !== 'claude.event').map((event) => event.type)).toEqual([
      'usage',
      'turn.finished',
    ]);
  });

  it('emits a partial line split across two stdout chunks only once, after the newline arrives', async () => {
    const { spawnFn, children } = createSpawnMock();
    const session = createSession(spawnFn);
    const events = collect(session);

    session.start('hello');
    const child = children[0]!;
    const line = readFixtureLines('allow')[0]!;

    child.stdout.write(line.slice(0, 10));
    await flush();
    expect(events).toHaveLength(0);

    child.stdout.write(`${line.slice(10)}\n`);
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'claude.event', payload: { engine: 'claude', raw: JSON.parse(line) } });
  });

  it('emits an error with the raw line for non-JSON stdout, without stopping the stream', async () => {
    const { spawnFn, children } = createSpawnMock();
    const session = createSession(spawnFn);
    const events = collect(session);

    session.start('hello');
    const child = children[0]!;
    const validLine = readFixtureLines('allow')[0]!;

    child.stdout.write('this is not json\n');
    child.stdout.write(`${validLine}\n`);
    await flush();

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'error', payload: { message: 'this is not json' } });
    expect(events[1]).toEqual({ type: 'claude.event', payload: { engine: 'claude', raw: JSON.parse(validLine) } });
  });

  it("send('hi') writes exactly the recorded stdin message shape", () => {
    const { spawnFn, children } = createSpawnMock();
    const session = createSession(spawnFn);

    session.start('first prompt');
    const child = children[0]!;

    session.send('hi');

    expect(child.stdin.writes.at(-1)).toBe('{"type":"user","message":{"role":"user","content":"hi"}}\n');
  });

  it('interrupt() sends SIGINT to the running child', () => {
    const { spawnFn, children } = createSpawnMock();
    const session = createSession(spawnFn);

    session.start('hello');
    const child = children[0]!;

    session.interrupt();

    expect(child.killSignals).toEqual(['SIGINT']);
  });

  it('respawns with --resume after the child exits, then writes the new message to the new child', async () => {
    const { spawnFn, calls, children } = createSpawnMock();
    const session = createSession(spawnFn);

    session.start('first prompt');
    const first = children[0]!;
    finishExit(first, 0, null);
    await flush();

    session.send('next');

    expect(children).toHaveLength(2);
    const secondCall = calls[1]!;
    expect(secondCall.args).toContain('--resume');
    expect(secondCall.args[secondCall.args.indexOf('--resume') + 1]).toBe(SESSION_ID);
    expect(secondCall.args).not.toContain('--session-id');

    const second = children[1]!;
    expect(second.stdin.writes.at(-1)).toBe(
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'next' } })}\n`,
    );
    // the dead first child never saw the follow-up message
    expect(first.stdin.writes).toHaveLength(1);
  });

  it('emits session.ended with the exit code and signal when the child exits', async () => {
    const { spawnFn, children } = createSpawnMock();
    const session = createSession(spawnFn);
    const events = collect(session);

    session.start('hello');
    finishExit(children[0]!, 0, null);
    await flush();

    expect(events.at(-1)).toEqual({ type: 'session.ended', payload: { exitCode: 0, signal: null, reason: 'exit' } });
  });

  it('emits session.ended with a signal and null exit code when killed', async () => {
    const { spawnFn, children } = createSpawnMock();
    const session = createSession(spawnFn);
    const events = collect(session);

    session.start('hello');
    session.interrupt();
    await flush();

    expect(events.at(-1)).toEqual({
      type: 'session.ended',
      payload: { exitCode: null, signal: 'SIGINT', reason: 'exit' },
    });
  });

  it('emits an error with the stderr tail before session.ended on a non-zero exit', async () => {
    const { spawnFn, children } = createSpawnMock();
    const session = createSession(spawnFn);
    const events = collect(session);

    session.start('hello');
    const child = children[0]!;
    child.stderr.write('a fatal problem happened');
    await flush();
    finishExit(child, 1, null);
    await flush();

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'error', payload: { message: 'a fatal problem happened' } });
    expect(events[1]).toEqual({ type: 'session.ended', payload: { exitCode: 1, signal: null, reason: 'error' } });
  });

  it('does not emit a stderr error when the exit is clean', async () => {
    const { spawnFn, children } = createSpawnMock();
    const session = createSession(spawnFn);
    const events = collect(session);

    session.start('hello');
    const child = children[0]!;
    child.stderr.write('just a warning');
    await flush();
    finishExit(child, 0, null);
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('session.ended');
  });

  it('handles a spawn error (e.g. ENOENT) without crashing: error then session.ended, exactly once', async () => {
    const { spawnFn, children } = createSpawnMock();
    const session = createSession(spawnFn);
    const events = collect(session);

    expect(() => session.start('hello')).not.toThrow();
    const child = children[0]!;

    expect(() => child.emit('error', new Error('spawn claude ENOENT'))).not.toThrow();
    // Node may also fire 'close' for the same failed spawn; it must not duplicate either event.
    expect(() => child.emit('close', null, null)).not.toThrow();
    await flush();

    expect(events).toEqual([
      { type: 'error', payload: { message: 'failed to start claude: spawn claude ENOENT' } },
      { type: 'session.ended', payload: { exitCode: null, signal: null, reason: 'error' } },
    ]);
  });

  it('names a missing working directory instead of the ENOENT Node reports for it', async () => {
    const { spawnFn, children } = createSpawnMock();
    const missing = join(CWD, 'crystal-bridge-no-such-dir');
    const session = createSession(spawnFn, { cwd: missing });
    const events = collect(session);

    session.start('hello');
    children[0]!.emit('error', new Error('spawn claude ENOENT'));
    await flush();

    expect(events[0]).toEqual({
      type: 'error',
      payload: { message: `failed to start claude: working directory not found: ${missing}` },
    });
  });

  it('clears the dead child on a spawn error, so the next send retries the spawn', () => {
    const { spawnFn, children } = createSpawnMock();
    const session = createSession(spawnFn);
    collect(session);

    session.start('hello');
    children[0]!.emit('error', new Error('spawn claude ENOENT'));

    session.send('again');

    expect(children).toHaveLength(2);
  });

  it('flushes a trailing stdout line with no newline yet as a claude.event before session.ended', async () => {
    const { spawnFn, children } = createSpawnMock();
    const session = createSession(spawnFn);
    const events = collect(session);

    session.start('hello');
    const child = children[0]!;
    const lines = readFixtureLines('allow');
    const lastLine = lines.at(-1)!;
    for (const line of lines.slice(0, -1)) child.stdout.write(`${line}\n`);
    child.stdout.write(lastLine); // no trailing newline: the process died mid-write
    await flush();

    finishExit(child, 0, null);
    await flush();

    expect(events.filter((event) => event.type === 'claude.event')).toHaveLength(lines.length);
    expect(events.at(-2)).toEqual({ type: 'claude.event', payload: { engine: 'claude', raw: JSON.parse(lastLine) } });
    expect(events.at(-1)).toEqual({ type: 'session.ended', payload: { exitCode: 0, signal: null, reason: 'exit' } });
  });

  it('emits an error when writing to stdin fails (e.g. EPIPE), without throwing', async () => {
    const { spawnFn } = createSpawnMockWithFailingStdin();
    const session = createSession(spawnFn);
    const events = collect(session);

    expect(() => session.start('hello')).not.toThrow();
    await flush();

    expect(events).toEqual([{ type: 'error', payload: { message: 'failed to write to claude: write EPIPE' } }]);
  });

  it('does not spawn a second process while the exited child is still closing, and delivers the text once it closes', async () => {
    const { spawnFn, calls, children } = createSpawnMock();
    const session = createSession(spawnFn);
    const events = collect(session);

    session.start('first prompt');
    const first = children[0]!;
    first.stdout.write('{"partial":');
    await flush();

    // 'exit' has fired but stdout has not drained, so 'close' has not.
    first.exitCode = 0;
    first.emit('exit', 0, null);

    session.send('next');
    expect(children).toHaveLength(1);

    first.stdout.write('true}');
    await flush();
    first.emit('close', 0, null);
    await flush();

    expect(events).toEqual([
      { type: 'claude.event', payload: { engine: 'claude', raw: { partial: true } } },
      { type: 'session.ended', payload: { exitCode: 0, signal: null, reason: 'exit' } },
      { type: 'session.resumed', payload: {} },
    ]);
    expect(children).toHaveLength(2);
    expect(calls[1]!.args).toContain('--resume');
    const second = children[1]!;
    expect(second.stdin.writes).toEqual([
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'next' } })}\n`,
    ]);

    // The new child is current and alive: the next send goes to it without another spawn.
    session.send('again');
    expect(children).toHaveLength(2);
    expect(second.stdin.writes).toHaveLength(2);
  });

  it('ignores a late close from a child that has already been replaced', async () => {
    const { spawnFn, children } = createSpawnMock();
    const session = createSession(spawnFn);
    const events = collect(session);

    session.start('hello');
    const first = children[0]!;
    first.emit('error', new Error('spawn claude ENOENT'));

    session.send('again');
    expect(children).toHaveLength(2);
    const second = children[1]!;
    second.stdout.write('{"from":"second"');
    await flush();

    // The failed first child's late 'close' must not touch the second child's state.
    first.emit('close', null, null);
    await flush();

    second.stdout.write('}\n');
    await flush();

    expect(events).toEqual([
      { type: 'error', payload: { message: 'failed to start claude: spawn claude ENOENT' } },
      { type: 'session.ended', payload: { exitCode: null, signal: null, reason: 'error' } },
      { type: 'session.resumed', payload: {} },
      { type: 'claude.event', payload: { engine: 'claude', raw: { from: 'second' } } },
    ]);

    session.send('third');
    expect(children).toHaveLength(2);
    expect(second.stdin.writes).toHaveLength(2);
  });

  describe('close', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('ends stdin immediately, then sends SIGTERM after 5s if the child is still running', () => {
      const { spawnFn, children } = createSpawnMock();
      const session = createSession(spawnFn);

      session.start('hello');
      const child = children[0]!;

      session.close();
      expect(child.stdin.writableEnded).toBe(true);
      expect(child.killSignals).toEqual([]);

      vi.advanceTimersByTime(5000);
      expect(child.killSignals).toEqual(['SIGTERM']);
    });

    it('does not send SIGTERM if the child already exited within the grace period', () => {
      const { spawnFn, children } = createSpawnMock();
      const session = createSession(spawnFn);

      session.start('hello');
      const child = children[0]!;

      session.close();
      finishExit(child, 0, null);
      vi.advanceTimersByTime(5000);

      expect(child.killSignals).toEqual([]);
    });

    it('does not throw when closed before start', () => {
      const { spawnFn } = createSpawnMock();
      const session = createSession(spawnFn);

      expect(() => session.close()).not.toThrow();
    });
  });
});

describe('ClaudeSession idle stop', () => {
  const IDLE_MS = 1000;
  const RESULT = `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false })}\n`;

  beforeEach(() => {
    // setImmediate stays real so flush() can drain the fake streams.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function finishTurn(child: FakeChild): Promise<void> {
    child.stdout.write(RESULT);
    await flush();
  }

  it('ends stdin once no send arrives within idleMs of a result, and reports the end as idle', async () => {
    const { spawnFn, children } = createSpawnMock();
    const session = createSession(spawnFn, { idleMs: IDLE_MS });
    const events = collect(session);

    session.start('hello');
    const child = children[0]!;
    await finishTurn(child);

    vi.advanceTimersByTime(IDLE_MS - 1);
    expect(child.stdin.writableEnded).toBe(false);
    vi.advanceTimersByTime(1);
    expect(child.stdin.writableEnded).toBe(true);

    finishExit(child, 0);
    await flush();
    expect(events.at(-1)).toEqual({ type: 'session.ended', payload: { exitCode: 0, signal: null, reason: 'idle' } });
  });

  it('never idles out while a turn is still running', async () => {
    const { spawnFn, children } = createSpawnMock();
    const session = createSession(spawnFn, { idleMs: IDLE_MS });

    session.start('hello');
    vi.advanceTimersByTime(IDLE_MS * 10);

    expect(children[0]!.stdin.writableEnded).toBe(false);
  });

  for (const [what, block] of [
    ['a Monitor', { type: 'tool_use', id: 't1', name: 'Monitor', input: { command: 'watch.sh' } }],
    [
      'a background command',
      { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'x', run_in_background: true } },
    ],
    [
      'a background agent',
      { type: 'tool_use', id: 't3', name: 'Agent', input: { prompt: 'x', run_in_background: true } },
    ],
  ] as const) {
    it(`never idles out, and stays busy, once it started ${what} that may still be running`, async () => {
      const { spawnFn, children } = createSpawnMock();
      const session = createSession(spawnFn, { idleMs: IDLE_MS });

      session.start('hello');
      const child = children[0]!;
      child.stdout.write(`${JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [block] } })}\n`);
      await finishTurn(child);
      vi.advanceTimersByTime(IDLE_MS * 10);

      expect(child.stdin.writableEnded).toBe(false);
      // Busy, so a Crystal deploy waits for it instead of cutting the background work off.
      expect(session.busy).toBe(true);
    });
  }

  it('cancels the idle timer on send, and starts it again after the next result', async () => {
    const { spawnFn, children } = createSpawnMock();
    const session = createSession(spawnFn, { idleMs: IDLE_MS });

    session.start('hello');
    const child = children[0]!;
    await finishTurn(child);
    vi.advanceTimersByTime(IDLE_MS - 1);

    session.send('more');
    vi.advanceTimersByTime(IDLE_MS * 10);
    expect(child.stdin.writableEnded).toBe(false);

    await finishTurn(child);
    vi.advanceTimersByTime(IDLE_MS);
    expect(child.stdin.writableEnded).toBe(true);
  });

  it('reports an idle stop as idle even when claude exits non-zero, with no error', async () => {
    const { spawnFn, children } = createSpawnMock();
    const session = createSession(spawnFn, { idleMs: IDLE_MS });
    const events = collect(session);

    session.start('hello');
    const child = children[0]!;
    await finishTurn(child);
    vi.advanceTimersByTime(IDLE_MS);
    finishExit(child, 1);
    await flush();

    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'session.ended', payload: { exitCode: 1, signal: null, reason: 'idle' } });
  });

  it('reports when its process has stopped, so a shutting-down node can wait for it', async () => {
    const { spawnFn, children } = createSpawnMock();
    const session = createSession(spawnFn, { idleMs: IDLE_MS });
    await session.stopped(); // nothing running yet
    session.start('hello');
    let done = false;
    void session.stopped().then(() => (done = true));
    session.close();
    await flush();
    expect(done).toBe(false);
    finishExit(children[0]!, 0);
    await flush();
    expect(done).toBe(true);
  });

  it('escalates to SIGTERM if the idle child does not exit within the grace period', async () => {
    const { spawnFn, children } = createSpawnMock();
    const session = createSession(spawnFn, { idleMs: IDLE_MS });
    const events = collect(session);

    session.start('hello');
    const child = children[0]!;
    await finishTurn(child);
    vi.advanceTimersByTime(IDLE_MS + 5000);
    await flush();

    expect(child.killSignals).toEqual(['SIGTERM']);
    expect(events.at(-1)).toMatchObject({ type: 'session.ended', payload: { reason: 'idle' } });
  });

  it('holds a send that arrives while the idle child is closing, then resumes with it', async () => {
    const { spawnFn, calls, children } = createSpawnMock();
    const session = createSession(spawnFn, { idleMs: IDLE_MS });
    const events = collect(session);

    session.start('hello');
    const first = children[0]!;
    await finishTurn(first);
    vi.advanceTimersByTime(IDLE_MS);

    session.send('wake up');
    expect(children).toHaveLength(1);
    expect(first.stdin.writes).toHaveLength(1);

    finishExit(first, 0);
    await flush();

    expect(children).toHaveLength(2);
    expect(calls[1]!.args).toContain('--resume');
    expect(children[1]!.stdin.writes).toEqual([
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'wake up' } })}\n`,
    ]);
    expect(events.slice(-2)).toEqual([
      { type: 'session.ended', payload: { exitCode: 0, signal: null, reason: 'idle' } },
      { type: 'session.resumed', payload: {} },
    ]);
  });

  it('emits session.resumed when a send respawns an ended session', async () => {
    const { spawnFn, children } = createSpawnMock();
    const session = createSession(spawnFn, { idleMs: IDLE_MS });
    const events = collect(session);

    session.start('hello');
    finishExit(children[0]!, 0);
    await flush();
    session.send('again');

    expect(children).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: 'session.resumed', payload: {} });
  });

  it('reads CRYSTAL_IDLE_MS when no idleMs is given', async () => {
    process.env.CRYSTAL_IDLE_MS = '50';
    try {
      const { spawnFn, children } = createSpawnMock();
      const session = createSession(spawnFn);
      session.start('hello');
      await finishTurn(children[0]!);
      vi.advanceTimersByTime(50);
      expect(children[0]!.stdin.writableEnded).toBe(true);
    } finally {
      delete process.env.CRYSTAL_IDLE_MS;
    }
  });
});

describe('ClaudeSession usage', () => {
  it('follows a rate_limit_event line with a usage event', async () => {
    const { spawnFn, children } = createSpawnMock();
    const session = createSession(spawnFn);
    const events = collect(session);
    session.start('hello');

    const raw = {
      type: 'rate_limit_event',
      rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 100, status: 'allowed' } } },
    };
    children[0]!.stdout.write(`${JSON.stringify(raw)}\n`);
    await flush();

    expect(events).toEqual([
      { type: 'claude.event', payload: { engine: 'claude', raw } },
      {
        type: 'usage',
        payload: { windows: [{ id: 'five_hour', label: '5h', usedPct: 25, resetsAt: 100000, status: 'allowed' }] },
      },
    ]);
  });
});

describe('ClaudeSession busy', () => {
  const RESULT = `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false })}\n`;

  it('is busy from a prompt or follow-up until its result, and not once the process ends', async () => {
    const { spawnFn, children } = createSpawnMock();
    const session = createSession(spawnFn, { idleMs: 60_000 });
    expect(session.busy).toBe(false);

    session.start('hello');
    expect(session.busy).toBe(true);
    children[0]!.stdout.write(RESULT);
    await flush();
    expect(session.busy).toBe(false);

    session.send('more');
    expect(session.busy).toBe(true);
    finishExit(children[0]!, 0);
    await flush();
    expect(session.busy).toBe(false);
  });
});

describe('ClaudeSession environment', () => {
  it('spawns claude with the given environment plus CRYSTAL_SESSION, so hooks can tell they run headless', () => {
    const { spawnFn, calls } = createSpawnMock();
    const session = new ClaudeSession({
      session: SESSION_ID,
      cwd: CWD,
      permissionUrl: PERMISSION_URL,
      spawn: spawnFn,
      env: { PATH: '/home/me/.cargo/bin:/usr/bin', CRYSTAL_NODE: 'local' },
    });
    session.start('hello');
    expect(calls[0]!.options.env).toEqual({
      PATH: '/home/me/.cargo/bin:/usr/bin',
      CRYSTAL_NODE: 'local',
      CRYSTAL_SESSION: SESSION_ID,
    });
  });
});

describe('ClaudeSession permission mode', () => {
  it('starts claude in the given mode, and resumes in the current one', async () => {
    const { spawnFn, calls, children } = createSpawnMock();
    const session = createSession(spawnFn, { permissionMode: 'auto' });
    session.start('hello');
    expect(calls[0]!.args.join(' ')).toContain('--permission-mode auto');

    session.setMode('plan');
    finishExit(children[0]!, 0);
    await flush();
    session.send('again');
    expect(calls[1]!.args.join(' ')).toContain('--permission-mode plan');
  });

  it('switches a running process with a set_permission_mode control request', () => {
    const { spawnFn, children } = createSpawnMock();
    const session = createSession(spawnFn, { permissionMode: 'auto' });
    session.start('hello');
    session.setMode('acceptEdits');
    const last = JSON.parse(children[0]!.stdin.writes.at(-1)!);
    expect(last).toMatchObject({
      type: 'control_request',
      request: { subtype: 'set_permission_mode', mode: 'acceptEdits' },
    });
    expect(typeof last.request_id).toBe('string');
  });
});

describe('ClaudeSession turn.finished', () => {
  const emitResult = async (subtype: string, result?: string, isError = false) => {
    const { spawnFn, children } = createSpawnMock();
    const session = createSession(spawnFn);
    const events = collect(session);
    session.start('hello');
    children[0]!.stdout.write(`${JSON.stringify({ type: 'result', subtype, is_error: isError, result })}\n`);
    await flush();
    return events.filter((e) => e.type === 'turn.finished');
  };

  it('follows a result line with a neutral turn.finished: success, interrupted or error, with a short summary', async () => {
    expect(await emitResult('success', 'Done. '.repeat(40))).toEqual([
      {
        type: 'turn.finished',
        payload: { outcome: 'success', summary: `${'Done. '.repeat(40)}`.trim().slice(0, 140) },
      },
    ]);
    expect(await emitResult('error_during_execution')).toEqual([
      { type: 'turn.finished', payload: { outcome: 'interrupted' } },
    ]);
    expect(await emitResult('error_max_turns', undefined, true)).toEqual([
      { type: 'turn.finished', payload: { outcome: 'error' } },
    ]);
  });

  it('carries the turn-s own cost, time and tokens; cost is the change in the process-s running total', async () => {
    const { spawnFn, children } = createSpawnMock();
    const session = createSession(spawnFn);
    const events = collect(session);
    session.start('hello');
    const result = (total: number, ms: number) =>
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        total_cost_usd: total,
        duration_ms: ms,
        usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 11, cache_creation_input_tokens: 13 },
      })}\n`;
    children[0]!.stdout.write(result(0.1, 900));
    await flush();
    session.send('more');
    children[0]!.stdout.write(result(0.25, 400));
    await flush();
    const stats = events.filter((e) => e.type === 'turn.finished').map((e) => e.payload);
    expect(stats[0]).toMatchObject({
      costUsd: 0.1,
      durationMs: 900,
      tokens: { input: 5, output: 7, cacheRead: 11, cacheWrite: 13 },
    });
    expect((stats[1] as { costUsd: number }).costUsd).toBeCloseTo(0.15);
    expect(stats[1]).toMatchObject({ durationMs: 400 });
  });
});
