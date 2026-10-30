/**
 * Records real `claude -p` stream-json output into test/fixtures so later code is
 * built against what the CLI actually emits. Run:
 *
 *   pnpm --filter @crystal-bridge/kingdom exec tsx scripts/capture.ts [scenario...]
 *
 * Scenarios: allow, deny, followup, interrupt (+ resume), slow-allow, background-agent.
 * With no arguments, all of them run. Every fixture line is passed through `scrub()`.
 *
 *   pnpm --filter @crystal-bridge/kingdom exec tsx scripts/capture.ts --rescrub
 *
 * re-applies `scrub()` to the existing fixtures in place, without running the CLI.
 */
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import http from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPermissionServer, type PermissionDecision, type PermissionRequest } from '../src/permissions.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
const HOME = homedir();
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const TIMEOUT_MS = 180_000;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Identity-like keys (account, org, user); session ids and message uuids are kept.
const ACCOUNT_KEY_RE = /^(account|org|organization|user)[_A-Za-z]*(id|uuid)$/i;
// Model identifiers. Excludes `claude-code` (client and URL name) and our own placeholders.
const MODEL_RE = /\bclaude-(?!code\b|model\b)[a-z0-9][a-z0-9.-]*[a-z0-9]\b/g;

// The task specified `echo crystal`, but the CLI auto-allows read-only commands like echo
// (permission_decision source "config", reason "subcommandResults") and never calls the
// permission tool. `touch` has a side effect, so it goes through `approve`.
const BASH_PROMPT = 'Run the shell command `touch crystal.txt` with Bash, then reply with the single word DONE.';
const BACKGROUND_AGENT_PROMPT =
  'Use the Agent tool exactly once, in the background, with description "Say done" and a prompt asking it to reply ' +
  'with the single word done and use no tools. After launching it, reply with the single word started and end your ' +
  'turn. When it finishes, reply with the single word finished.';
// The CLI blocks a standalone `sleep 30` itself ("Blocked: standalone sleep 30 ..."
// tool_use_error), so the long-running command is a python sleep instead.
const SLEEP_PROMPT =
  "Run the shell command `python3 -c 'import time; time.sleep(30)'` with Bash, then reply with the single word DONE.";

// ---------------------------------------------------------------------------
// Scrubbing

// Each distinct model id gets its own placeholder, so modelUsage keys stay distinct.
const modelPlaceholders = new Map<string, string>();
function modelPlaceholder(id: string): string {
  let p = modelPlaceholders.get(id);
  if (!p) {
    p = modelPlaceholders.size === 0 ? 'claude-model' : `claude-model-${modelPlaceholders.size + 1}`;
    modelPlaceholders.set(id, p);
  }
  return p;
}

/** Account usage data: keep the keys, use fixed neutral values. */
function neutralRateLimit(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(neutralRateLimit);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'overageDisabledReason') continue;
      if (k === 'resetsAt' || k === 'utilization') out[k] = 0;
      else if (k === 'status') out[k] = 'allowed';
      else if (k === 'overageStatus') out[k] = 'rejected';
      else out[k] = neutralRateLimit(v);
    }
    return out;
  }
  return value;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace the temp repo path (and its encoded project-dir form), $HOME paths and emails in raw text. */
function scrubText(text: string, tempPath: string): string {
  // A background task's output file, under a folder named after this machine's temp path.
  let out = text.replace(/\/(?:private\/)?tmp\/claude-[^/"\s]+\/[^"\s]*?\/tasks\//g, '/tmp/FIXTURE-tasks/');
  if (tempPath) {
    out = out.replace(new RegExp(escapeRe(tempPath), 'g'), '/tmp/FIXTURE');
    // ~/.claude/projects/<cwd with / and . replaced by ->
    out = out.replace(new RegExp(escapeRe(tempPath.replace(/[/.]/g, '-')), 'g'), '-tmp-FIXTURE');
  }
  // The same folder as the CLI encodes it once it has resolved symlinks, as macOS does for its temp directory.
  out = out.replace(/-[A-Za-z0-9-]*-crystal-capture-[A-Za-z0-9]+/g, '-tmp-FIXTURE');
  out = out.replace(new RegExp(escapeRe(HOME), 'g'), '/HOME');
  out = out.replace(EMAIL_RE, 'user@example.com');
  out = out.replace(MODEL_RE, modelPlaceholder);
  return out;
}

function scrubAccountIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubAccountIds);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = typeof v === 'string' && ACCOUNT_KEY_RE.test(k) && UUID_RE.test(v) ? ZERO_UUID : scrubAccountIds(v);
    }
    return out;
  }
  return value;
}

/** Sanitize one stdout line. Lines carrying machine inventories (system/init) are rebuilt; others get text replacement. */
export function scrub(line: string, tempPath: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return scrubText(line, tempPath);
  }
  const obj = parsed as Record<string, unknown>;
  const carriesInventory =
    obj.type === 'system' &&
    ['tools', 'mcp_servers', 'slash_commands', 'skills', 'agents', 'plugins', 'output_style'].some((k) => k in obj);
  let next: Record<string, unknown> = obj;
  if (carriesInventory) {
    next = { ...obj };
    if (Array.isArray(obj.tools)) {
      next.tools = (obj.tools as unknown[]).filter(
        (t) => typeof t === 'string' && (!t.startsWith('mcp__') || t === 'mcp__crystal__approve'),
      );
    }
    if ('mcp_servers' in obj && Array.isArray(obj.mcp_servers)) {
      next.mcp_servers = (obj.mcp_servers as Array<Record<string, unknown>>).filter((s) => s.name === 'crystal');
    }
    for (const k of ['slash_commands', 'skills', 'agents', 'plugins']) if (k in obj) next[k] = [];
    if ('output_style' in obj) next.output_style = 'default';
    if ('cwd' in obj) next.cwd = '/tmp/FIXTURE';
  }
  const isRateLimit = obj.type === 'rate_limit_event' && 'rate_limit_info' in obj;
  if (isRateLimit) next = { ...next, rate_limit_info: neutralRateLimit(obj.rate_limit_info) };
  const scrubbed = scrubAccountIds(next);
  const changed = carriesInventory || isRateLimit || JSON.stringify(scrubbed) !== JSON.stringify(obj);
  return scrubText(changed ? JSON.stringify(scrubbed) : line, tempPath);
}

// ---------------------------------------------------------------------------
// Raw-argument recorder: a pass-through proxy in front of the permission server,
// so we see exactly what the CLI sends to `approve` (zod would strip extras).

interface RawCall {
  session: string;
  method: string;
  params: unknown;
  at: string;
}

function startRecordingProxy(targetPort: number, calls: RawCall[]): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const session = (req.url ?? '').split('/').pop() ?? '';
      try {
        const msg = JSON.parse(body.toString('utf8')) as { method?: string; params?: unknown };
        if (msg.method === 'tools/call' || msg.method === 'initialize' || msg.method === 'tools/list') {
          calls.push({ session, method: msg.method, params: msg.params ?? null, at: new Date().toISOString() });
        }
      } catch {
        /* not JSON; forward anyway */
      }
      const upstream = http.request(
        { host: '127.0.0.1', port: targetPort, path: req.url, method: req.method, headers: req.headers },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      upstream.end(body);
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Running one CLI process

interface RunResult {
  lines: string[];
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  notes: string[];
}

interface RunOptions {
  repo: string;
  mcpUrl: string;
  sessionArgs: string[];
  firstPrompt: string;
  env?: Record<string, string>;
  /** For a run that never asks for approval: no permission tool, so it needs no local server. */
  noApprovals?: boolean;
  /** Called per parsed line; may write further messages or close stdin via the controls. */
  onLine(msg: Record<string, unknown>, ctl: Controls): void;
}

interface Controls {
  send(text: string): void;
  end(): void;
  kill(signal: NodeJS.Signals): void;
  note(s: string): void;
  alive(): boolean;
}

function userMessage(text: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;
}

function runClaude(opts: RunOptions): Promise<RunResult> {
  const mcpConfig = JSON.stringify({ mcpServers: { crystal: { type: 'http', url: opts.mcpUrl } } });
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    ...(opts.noApprovals ? [] : ['--mcp-config', mcpConfig, '--permission-prompt-tool', 'mcp__crystal__approve']),
    ...opts.sessionArgs,
  ];
  const child = spawn('claude', args, {
    cwd: opts.repo,
    env: { ...process.env, ...opts.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const result: RunResult = { lines: [], stderr: '', exitCode: null, signal: null, timedOut: false, notes: [] };
  const ctl: Controls = {
    send: (text) => {
      if (child.stdin.writable) child.stdin.write(userMessage(text));
    },
    end: () => child.stdin.end(),
    kill: (signal) => child.kill(signal),
    note: (s) => result.notes.push(`${new Date().toISOString()} ${s}`),
    alive: () => child.exitCode === null && child.signalCode === null,
  };
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      result.lines.push(line);
      try {
        opts.onLine(JSON.parse(line) as Record<string, unknown>, ctl);
      } catch (e) {
        ctl.note(`unparseable or handler error: ${(e as Error).message}`);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c: string) => (result.stderr += c));
  child.stdin.on('error', () => {});
  child.stdin.write(userMessage(opts.firstPrompt));

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      result.timedOut = true;
      ctl.note('timeout: killing child');
      child.kill('SIGKILL');
    }, TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (buffer.trim()) result.lines.push(buffer);
      result.exitCode = code;
      result.signal = signal;
      resolve(result);
    });
  });
}

function hasToolUse(msg: Record<string, unknown>): boolean {
  if (msg.type !== 'assistant') return false;
  const content = (msg.message as { content?: Array<{ type?: string }> } | undefined)?.content ?? [];
  return content.some((c) => c.type === 'tool_use');
}

// ---------------------------------------------------------------------------
// Main

type Answer = (r: PermissionRequest) => Promise<PermissionDecision>;
const allow: Answer = async () => ({ behavior: 'allow' });

async function rescrub(): Promise<void> {
  for (const name of await readdir(FIXTURES)) {
    const path = join(FIXTURES, name);
    const text = await readFile(path, 'utf8');
    if (name.endsWith('.ndjson')) {
      const lines = text.split('\n').filter((l) => l.trim());
      await writeFile(path, lines.map((l) => `${scrub(l, '')}\n`).join(''));
    } else if (name === 'permission-calls.json') {
      await writeFile(path, scrubText(text, ''));
    } else continue;
    console.log(`rescrubbed ${name}`);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--rescrub')) return rescrub();
  const wanted = new Set(process.argv.slice(2));
  const want = (s: string) => wanted.size === 0 || wanted.has(s);

  const repo = await mkdtemp(join(tmpdir(), 'crystal-capture-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  await writeFile(join(repo, 'README.md'), 'fixture repo\n');

  const answers = new Map<string, Answer>();
  const sessionScenario = new Map<string, string>();
  const requests: Array<
    PermissionRequest & { scenario: string; at: string; answeredAt?: string; decision?: PermissionDecision }
  > = [];
  const server = await createPermissionServer({
    port: 0,
    onRequest: async (r) => {
      const entry = {
        ...r,
        scenario: sessionScenario.get(r.session) ?? '?',
        at: new Date().toISOString(),
      } as (typeof requests)[number];
      requests.push(entry);
      const decision = await (answers.get(r.session) ?? allow)(r);
      entry.answeredAt = new Date().toISOString();
      entry.decision = decision;
      return decision;
    },
  });
  const rawCalls: RawCall[] = [];
  const proxy = await startRecordingProxy(server.port, rawCalls);
  const mcpUrl = (session: string) => `http://127.0.0.1:${proxy.port}/mcp/${session}`;

  await mkdir(FIXTURES, { recursive: true });
  const summary: Record<string, unknown> = {};

  const record = async (name: string, res: RunResult, extra: Record<string, unknown> = {}) => {
    await writeFile(join(FIXTURES, `${name}.ndjson`), res.lines.map((l) => `${scrub(l, repo)}\n`).join(''));
    summary[name] = {
      exitCode: res.exitCode,
      signal: res.signal,
      timedOut: res.timedOut,
      lineCount: res.lines.length,
      notes: res.notes,
      stderrTail: scrubText(res.stderr.slice(-1500), repo),
      lastLines: res.lines.slice(-3).map((l) => scrub(l, repo).slice(0, 400)),
      ...extra,
    };
    console.log(
      `[${name}] exit=${res.exitCode} signal=${res.signal} timedOut=${res.timedOut} lines=${res.lines.length}`,
    );
  };

  const closeAfterFirstResult = (msg: Record<string, unknown>, ctl: Controls) => {
    if (msg.type === 'result') ctl.end();
  };

  const simple = async (name: string, prompt: string, answer: Answer, env?: Record<string, string>) => {
    const session = randomUUID();
    answers.set(session, answer);
    sessionScenario.set(session, name);
    return runClaude({
      repo,
      mcpUrl: mcpUrl(session),
      sessionArgs: ['--session-id', session],
      firstPrompt: prompt,
      env,
      onLine: closeAfterFirstResult,
    });
  };

  try {
    if (want('allow')) await record('allow', await simple('allow', BASH_PROMPT, allow));
    if (want('background-agent')) {
      const session = randomUUID();
      sessionScenario.set(session, 'background-agent');
      let finished = false;
      await record(
        'background-agent',
        await runClaude({
          repo,
          mcpUrl: mcpUrl(session),
          // As a Quest runs by default: the agent launches with no approval to wait on.
          noApprovals: true,
          sessionArgs: ['--session-id', session, '--permission-mode', 'auto'],
          firstPrompt: BACKGROUND_AGENT_PROMPT,
          onLine: (msg, ctl) => {
            if (msg.type === 'system' && msg.subtype === 'task_notification') finished = true;
            // The turn the notification starts, not the one that launched the agent.
            if (finished && msg.type === 'result') ctl.end();
          },
        }),
      );
    }
    if (want('deny')) {
      await record(
        'deny',
        await simple('deny', BASH_PROMPT, async () => ({ behavior: 'deny', message: 'denied in capture' })),
      );
    }

    if (want('followup')) {
      const session = randomUUID();
      sessionScenario.set(session, 'followup');
      let results = 0;
      const res = await runClaude({
        repo,
        mcpUrl: mcpUrl(session),
        sessionArgs: ['--session-id', session],
        firstPrompt: BASH_PROMPT,
        onLine: (msg, ctl) => {
          if (msg.type !== 'result') return;
          results += 1;
          if (results === 1) {
            ctl.note('first result: sending second user message, then closing stdin');
            ctl.send('Reply with the single word AGAIN.');
            ctl.end();
          }
        },
      });
      await record('followup', res, { results });
    }

    if (want('interrupt')) {
      const session = randomUUID();
      sessionScenario.set(session, 'interrupt');
      let sigintAt = 0;
      const res = await runClaude({
        repo,
        mcpUrl: mcpUrl(session),
        sessionArgs: ['--session-id', session],
        firstPrompt: SLEEP_PROMPT,
        onLine: (msg, ctl) => {
          if (hasToolUse(msg) && !sigintAt) {
            sigintAt = -1;
            ctl.note('tool_use seen; SIGINT in 2s');
            setTimeout(() => {
              sigintAt = Date.now();
              ctl.note('sending SIGINT');
              ctl.kill('SIGINT');
              setTimeout(() => {
                if (!ctl.alive()) return;
                ctl.note('still alive 20s after SIGINT; SIGKILL');
                ctl.kill('SIGKILL');
              }, 20_000).unref();
            }, 2000);
          }
        },
      });
      const exitedAfterMs = sigintAt > 0 ? Date.now() - sigintAt : null;
      await record('interrupt', res, { exitedAfterSigintMs: exitedAfterMs });

      const resumed = await runClaude({
        repo,
        mcpUrl: mcpUrl(session),
        sessionArgs: ['--resume', session],
        firstPrompt: 'Reply with the single word RESUMED.',
        onLine: closeAfterFirstResult,
      });
      const init = resumed.lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((m) => m.type === 'system' && m.subtype === 'init');
      await record('resume', resumed, {
        resumedSessionId: init?.session_id ?? null,
        sameSession: init?.session_id === session,
      });
    }

    if (want('slow-allow')) {
      const slow: Answer = () => new Promise((r) => setTimeout(() => r({ behavior: 'allow' }), 60_000));
      await record('slow-allow', await simple('slow-allow', BASH_PROMPT, slow));
      const s = summary['slow-allow'] as { lastLines: string[] };
      const text = await readFile(join(FIXTURES, 'slow-allow.ndjson'), 'utf8');
      const ok = text.includes('"type":"result"') && !/timed? ?out/i.test(text);
      summary['slow-allow-ok'] = ok;
      if (!ok) {
        console.log('[slow-allow] did not complete cleanly; retrying with MCP_TOOL_TIMEOUT=300000', s.lastLines);
        await record(
          'slow-allow-mcp-timeout',
          await simple('slow-allow-mcp-timeout', BASH_PROMPT, slow, { MCP_TOOL_TIMEOUT: '300000' }),
        );
      }
    }
  } finally {
    await proxy.close();
    await server.close();
    await rm(repo, { recursive: true, force: true });
  }

  // When only some scenarios ran, keep the other scenarios' recorded calls.
  const ran = new Set(sessionScenario.values());
  let previous: { onRequest: Array<{ scenario: string }>; wire: Array<{ scenario: string }> } = {
    onRequest: [],
    wire: [],
  };
  if (wanted.size > 0) {
    try {
      previous = JSON.parse(await readFile(join(FIXTURES, 'permission-calls.json'), 'utf8')) as typeof previous;
    } catch {
      /* no earlier file */
    }
  }
  const keep = <T extends { scenario: string }>(xs: T[]) => xs.filter((x) => !ran.has(x.scenario));
  const permissionCalls = {
    // What onRequest received (after Task 4's zod parsing).
    onRequest: [...keep(previous.onRequest), ...requests],
    // What the CLI put on the wire (JSON-RPC params), per scenario.
    wire: [...keep(previous.wire), ...rawCalls.map((c) => ({ scenario: sessionScenario.get(c.session) ?? '?', ...c }))],
  };
  await writeFile(
    join(FIXTURES, 'permission-calls.json'),
    `${scrubText(JSON.stringify(permissionCalls, null, 2), repo)}\n`,
  );
  console.log(scrubText(JSON.stringify(summary, null, 2), repo));
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
