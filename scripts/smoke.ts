/**
 * End-to-end smoke test: with `pnpm dev` (or the three apps) already running, this
 * connects to the Airship's `/client` WebSocket like the web client would, starts a
 * real Claude Code session in a fresh temp git repo, approves the one permission
 * request it raises, and checks the side effect actually happened on disk. The Quest also names itself with
 * Crystal's `title` tool, which must not ask, and the hub must list it under that name and then a name set by hand.
 * It also leaves an Errand, unasked, for the one step only the user can take; the hub must list it open, then done.
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
const RENAMED = 'Smoke test, renamed';
// Never mentions naming or Errands: the Quest's system prompt asks for those, as for every Quest.
const PROMPT =
  'Run the shell command `touch crystal.txt` with Bash. I will delete crystal.txt by hand myself later. Then reply with the single word DONE.';
const RESULT_TIMEOUT_MS = 120_000;
const CHANGES_TIMEOUT_MS = 5_000;
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
  /** What the Quest named itself. */
  titled?: { title: unknown; plain: unknown };
  /** The `errand.left` payloads the Quest sent. */
  left?: Array<Record<string, unknown>>;
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
    let titled: { title: unknown; plain: unknown } | undefined;
    const left: Array<Record<string, unknown>> = [];
    let changesTimer: NodeJS.Timeout | undefined;
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

      if (envelope.type === 'quest.titled' && isObj(payload)) titled = { title: payload.title, plain: payload.plain };
      if (envelope.type === 'permission.request' && isObj(payload) && String(payload.toolName).includes('__title')) {
        finish({ ok: false, message: 'the title tool asked for permission; Crystal should allow it up front' });
        return;
      }
      if (envelope.type === 'permission.request' && isObj(payload) && String(payload.toolName).includes('__errand')) {
        finish({ ok: false, message: 'the errand tool asked for permission; Crystal should allow it up front' });
        return;
      }
      if (envelope.type === 'errand.left' && isObj(payload)) left.push(payload);
      if (envelope.type === 'permission.request' && isObj(payload) && typeof payload.requestId === 'string') {
        console.log(`smoke: approving permission request for ${String(payload.toolName)}`);
        send({
          kind: 'command',
          command: { type: 'permission.answer', session, requestId: payload.requestId, behavior: 'allow' },
        });
        return;
      }

      if (envelope.type === 'claude.event' && isObj(payload) && isObj(payload.raw)) {
        const { raw } = payload;
        // A shell made the change, so this line shows the node saw it without any file tool.
        if (raw.type === 'system' && raw.subtype === 'turn_changes') {
          clearTimeout(changesTimer);
          const seen = Array.isArray(raw.files) && raw.files.includes('crystal.txt');
          if (!seen) finish({ ok: false, message: `turn_changes missed crystal.txt: ${String(raw.files)}` });
          else if (!titled) finish({ ok: false, message: 'the Quest never named itself (no quest.titled)' });
          else if (left.length === 0) finish({ ok: false, message: 'the Quest left no Errand (no errand.left)' });
          else finish({ ok: true, titled, left });
          return;
        }
        if (raw.type === 'result') {
          changesTimer = setTimeout(
            () => finish({ ok: false, message: 'a result arrived, but no turn_changes line followed it' }),
            CHANGES_TIMEOUT_MS,
          );
          return;
        }
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

/** The Quest's name as the hub lists it: the one it gave itself, then one set by hand. Why not, or nothing. */
async function checkTitles(
  base: string,
  session: string,
  titled: { title: unknown; plain: unknown },
): Promise<string | undefined> {
  const listed = async () => {
    const sessions = (await (await fetch(`${base}/api/sessions`)).json()) as unknown;
    return Array.isArray(sessions) ? sessions.find((row) => isObj(row) && row.id === session) : undefined;
  };
  const named = await listed();
  if (!isObj(named) || named.label !== titled.title || named.plainLabel !== titled.plain) {
    return `the hub lists the Quest as ${JSON.stringify(named)}, not under the name it gave itself`;
  }
  const response = await fetch(`${base}/api/sessions/${session}/label`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: RENAMED }),
  });
  if (response.status !== 204) return `renaming the Quest returned HTTP ${response.status}`;
  const renamed = await listed();
  if (!isObj(renamed) || renamed.label !== RENAMED) return `after a rename the hub lists ${JSON.stringify(renamed)}`;
  console.log(`smoke: the Quest named itself "${String(titled.title)}" and took "${RENAMED}" by hand`);
  return undefined;
}

/** The Errands the Quest left, as the hub lists them: open, then done by hand. Why not, or nothing. */
async function checkErrands(
  base: string,
  node: string,
  session: string,
  cwd: string,
  left: Array<Record<string, unknown>>,
): Promise<string | undefined> {
  const url = `${base}/api/nodes/${encodeURIComponent(node)}/errands`;
  const listed = async (): Promise<unknown[]> => {
    const body = (await (await fetch(url)).json()) as unknown;
    return isObj(body) && Array.isArray(body.errands) ? body.errands : [];
  };
  const find = (rows: unknown[], id: unknown) => rows.find((row) => isObj(row) && row.id === id);

  const open = await listed();
  for (const errand of left) {
    const row = find(open, errand.id);
    if (!isObj(row)) return `the hub does not list the Errand ${String(errand.id)}`;
    if (row.session !== session || row.project !== cwd || row.state !== 'open' || row.by !== 'quest') {
      return `the hub lists the Errand as ${JSON.stringify(row)}, not open, by the Quest, in this session and folder`;
    }
  }
  for (const errand of left) {
    const response = await fetch(`${url}/${encodeURIComponent(String(errand.id))}/state`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'done' }),
    });
    if (response.status !== 200) return `marking an Errand done returned HTTP ${response.status}`;
    const body = (await response.json()) as unknown;
    if (!isObj(body) || !isObj(body.errand) || body.errand.closed === undefined) {
      return `marking an Errand done answered ${JSON.stringify(body)}, with no closed time`;
    }
  }
  const done = await listed();
  for (const errand of left) {
    const row = find(done, errand.id);
    if (!isObj(row) || row.state !== 'done') return `after marking it done the hub lists ${JSON.stringify(row)}`;
  }
  console.log(
    `smoke: the Quest left ${left.length} Errand(s), "${String(left[0].title)}" first, and they closed by hand`,
  );
  return undefined;
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

    const failure = await checkTitles(base, session, outcome.titled!);
    if (failure) {
      reportFailure(failure, recent);
      return;
    }

    const errandFailure = await checkErrands(base, node, session, repo, outcome.left!);
    if (errandFailure) {
      reportFailure(errandFailure, recent);
      return;
    }

    console.log(
      'smoke: PASS - result event arrived, crystal.txt exists, the turn reported it, the Quest was named and left an Errand',
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  reportFailure(`unexpected error: ${errorMessage(error)}`, []);
});
