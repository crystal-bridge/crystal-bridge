/**
 * End-to-end smoke test: with `pnpm dev` (or the three apps) already running, this
 * connects to the Airship's `/client` WebSocket like the web client would, starts a
 * real Claude Code session in a fresh temp git repo, approves the one permission
 * request it raises, and checks the side effect actually happened on disk.
 *
 * Run with: `pnpm smoke` (= `tsx scripts/smoke.ts`). `SMOKE_ENGINE=interactive pnpm smoke` runs it on the
 * interactive engine instead, which the node must offer (`CRYSTAL_ENGINES=stream,interactive`).
 *
 * This file intentionally doesn't depend on `@crystal-bridge/protocol`: it's a
 * standalone script, so it treats the wire frames as plain JSON matching the shapes
 * documented in `packages/protocol/src/{envelope,commands}.ts`, and uses Node 22's
 * global `fetch` and `WebSocket` instead of adding `ws` as a root dependency.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLIENT_URL = process.env.AIRSHIP_CLIENT_URL ?? 'ws://127.0.0.1:7700/client';
const ENGINE = process.env.SMOKE_ENGINE || undefined;
const PROMPT = 'Run the shell command `touch crystal.txt` with Bash, then reply with the single word DONE.';
const RESULT_TIMEOUT_MS = 120_000;
const MAX_RECENT = 10;
const MAX_EVENT_CHARS = 400;

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/** `ws://host:port/client` -> `http://host:port` (and `wss:` -> `https:`). */
function httpBase(clientUrl: string): string {
  const url = new URL(clientUrl);
  const protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  return `${protocol}//${url.host}`;
}

function reportFailure(message: string, recent: unknown[]): void {
  console.error(`smoke: FAIL - ${message}`);
  if (recent.length > 0) {
    console.error('smoke: last events seen:');
    for (const event of recent.slice(-MAX_RECENT)) {
      console.error(`  ${truncate(JSON.stringify(event), MAX_EVENT_CHARS)}`);
    }
  }
  process.exitCode = 1;
}

interface WaitOutcome {
  ok: boolean;
  message?: string;
}

interface WaitOptions {
  clientUrl: string;
  node: string;
  session: string;
  cwd: string;
  recent: unknown[];
}

/**
 * Opens the `/client` socket, starts the session, answers any permission request with
 * `allow`, and resolves once a `claude.event` envelope carries a stream-json `result`
 * line (or fails on a hub error, a closed socket, or the timeout).
 */
function waitForResult(options: WaitOptions): Promise<WaitOutcome> {
  const { clientUrl, node, session, cwd, recent } = options;

  return new Promise<WaitOutcome>((resolve) => {
    let settled = false;
    const socket = new WebSocket(clientUrl);

    const timer = setTimeout(() => {
      finish({ ok: false, message: `timed out after ${RESULT_TIMEOUT_MS / 1000}s waiting for a result event` });
    }, RESULT_TIMEOUT_MS);

    function finish(outcome: WaitOutcome): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closing/closed */
      }
      resolve(outcome);
    }

    function send(message: unknown): void {
      socket.send(JSON.stringify(message));
    }

    socket.addEventListener('open', () => {
      send({ kind: 'subscribe', session, fromSeq: 0 });
      send({
        kind: 'command',
        command: {
          type: 'session.start',
          node,
          session,
          cwd,
          prompt: PROMPT,
          ...(ENGINE ? { engine: ENGINE } : {}),
        },
      });
    });

    socket.addEventListener('message', (event: MessageEvent) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!isObj(frame)) return;

      if (frame.kind === 'error') {
        finish({ ok: false, message: `hub reported an error: ${String(frame.message)}` });
        return;
      }
      if (frame.kind !== 'event' || !isObj(frame.event)) return;

      const envelope = frame.event;
      recent.push(envelope);
      if (recent.length > MAX_RECENT) recent.shift();

      const payload = envelope.payload;

      if (envelope.type === 'permission.request' && isObj(payload) && typeof payload.requestId === 'string') {
        console.log(`smoke: approving permission request for ${String(payload.toolName)}`);
        send({
          kind: 'command',
          command: { type: 'permission.answer', session, requestId: payload.requestId, behavior: 'allow' },
        });
        return;
      }

      if (envelope.type === 'claude.event' && isObj(payload) && isObj(payload.raw) && payload.raw.type === 'result') {
        finish({ ok: true });
        return;
      }

      if (envelope.type === 'error') {
        console.error(`smoke: node reported an error event: ${JSON.stringify(payload)}`);
      }
    });

    socket.addEventListener('close', () => {
      finish({ ok: false, message: 'the hub closed the /client connection before a result event arrived' });
    });
  });
}

async function main(): Promise<void> {
  const base = httpBase(CLIENT_URL);

  let nodes: unknown;
  try {
    const response = await fetch(`${base}/api/nodes`);
    if (!response.ok) {
      reportFailure(`GET ${base}/api/nodes returned HTTP ${response.status}`, []);
      return;
    }
    nodes = await response.json();
  } catch (error) {
    reportFailure(`could not reach the Airship hub at ${base}: ${errorMessage(error)}`, []);
    return;
  }

  if (!Array.isArray(nodes) || nodes.length === 0 || typeof nodes[0] !== 'string') {
    reportFailure('no nodes are connected to the hub (GET /api/nodes was empty) - start the Crystal agent first', []);
    return;
  }
  const node = nodes[0];
  console.log(`smoke: using node "${node}"`);

  const repo = await mkdtemp(join(tmpdir(), 'crystal-bridge-smoke-'));
  console.log(`smoke: temp repo ${repo}`);

  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });

    const session = randomUUID();
    const recent: unknown[] = [];
    console.log(`smoke: starting session ${session}${ENGINE ? ` on the ${ENGINE} engine` : ''}`);

    const outcome = await waitForResult({ clientUrl: CLIENT_URL, node, session, cwd: repo, recent });
    if (!outcome.ok) {
      reportFailure(outcome.message ?? 'unknown failure', recent);
      return;
    }

    if (!existsSync(join(repo, 'crystal.txt'))) {
      reportFailure('a result event arrived, but crystal.txt was never created in the temp repo', recent);
      return;
    }

    console.log('smoke: PASS - result event arrived and crystal.txt exists');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  reportFailure(`unexpected error: ${errorMessage(error)}`, []);
});
