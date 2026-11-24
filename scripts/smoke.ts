/**
 * End-to-end smoke test: with `pnpm dev` (or the three apps) already running, this
 * connects to the Airship's `/client` WebSocket like the web client would, starts a
 * real Claude Code session in a fresh temp git repo, approves the one permission
 * request it raises, and checks the side effect actually happened on disk. The Quest also names itself with
 * Crystal's `title` tool, which must not ask, and the hub must list it under that name and then a name set by hand.
 * It also leaves an Errand, unasked, for the one step only the user can take; the hub must list it open, then done.
 * Crystal must tally the turn after its diff (`turn.tally`, counting crystal.txt), and the hub must list the turn's
 * record among the Kingdom's Deeds. Then it closes the Quest asking for Deeds at Close: the call must record at least
 * one, and the hub must list them and the call's own row.
 *
 * When the Kingdom offers a Library, it also writes a Tome through the hub, reads it back, and checks that a write
 * from a stale version is refused.
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
const CLOSING_TIMEOUT_MS = 150_000;
const DAY_MS = 86_400_000;
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
  /** The seq of the turn's `turn.finished`, which its tally and record carry. */
  seq?: number;
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
    let finishedSeq: number | undefined;
    let changed = false;
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
      if (envelope.type === 'turn.finished' && typeof envelope.seq === 'number') finishedSeq = envelope.seq;
      // Crystal tallies the turn once its diff is in, naming the turn by its turn.finished's seq.
      if (envelope.type === 'turn.tally' && changed && isObj(payload) && payload.seq === finishedSeq) {
        clearTimeout(changesTimer);
        const files = typeof payload.files === 'number' ? payload.files : 0;
        if (files < 1) finish({ ok: false, message: `the tally missed crystal.txt: ${JSON.stringify(payload)}` });
        else finish({ ok: true, titled, left, seq: finishedSeq });
        return;
      }
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
          else if (finishedSeq === undefined) finish({ ok: false, message: 'the turn ended with no turn.finished' });
          else {
            // The tally follows the diff; wait for it instead of finishing here.
            changed = true;
            changesTimer = setTimeout(
              () => finish({ ok: false, message: 'no turn.tally followed the turn' }),
              CHANGES_TIMEOUT_MS,
            );
          }
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

/** The rows of a Kingdom's Deeds from the last day, as the hub lists them. */
async function recentDeeds(base: string, node: string): Promise<unknown[]> {
  const url = `${base}/api/nodes/${encodeURIComponent(node)}/deeds?after=${Date.now() - DAY_MS}`;
  const body = (await (await fetch(url)).json()) as unknown;
  return isObj(body) && Array.isArray(body.deeds) ? body.deeds : [];
}

/** The turn's record among the Kingdom's Deeds, with the tally's files. Why not, or nothing. */
async function checkDeeds(base: string, node: string, session: string, seq: number): Promise<string | undefined> {
  const id = `turn:${session}:${seq}`;
  const row = (await recentDeeds(base, node)).find((deed) => isObj(deed) && deed.id === id);
  if (!isObj(row)) return `the hub's Deeds do not list the turn's record ${id}`;
  if (row.kind !== 'turn' || typeof row.files !== 'number' || row.files < 1) {
    return `the hub lists the turn's record as ${JSON.stringify(row)}, not a turn with crystal.txt counted`;
  }
  console.log(`smoke: the turn was tallied (${row.files} file(s)) and the hub lists its record ${id}`);
  return undefined;
}

interface Closing {
  message?: string;
  costUsd?: unknown;
  recorded?: number;
}

/**
 * Closes the Quest asking for Deeds at Close and waits for the call's outcome: it must record at least one Deed, and
 * the hub must list them and the call's own row. Why not, or nothing.
 */
async function closeWithDeeds(
  clientUrl: string,
  base: string,
  node: string,
  session: string,
  recent: unknown[],
): Promise<string | undefined> {
  const engines = (await (await fetch(`${base}/api/engines`)).json()) as unknown;
  const offered =
    Array.isArray(engines) && engines.some((row) => isObj(row) && row.node === node && row.deeds === true);
  if (!offered) return "this Kingdom doesn't offer Deeds at Close";

  const closing = await new Promise<Closing>((resolve) => {
    let settled = false;
    let recorded = 0;
    const socket = new WebSocket(clientUrl);
    const timer = setTimeout(
      () => finish({ message: `no deeds.closing within ${CLOSING_TIMEOUT_MS / 1000}s of the Close` }),
      CLOSING_TIMEOUT_MS,
    );

    function finish(outcome: Closing): void {
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

    // The replay from seq 0 holds no deeds.closing: this is the Quest's first Close.
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ kind: 'subscribe', session, fromSeq: 0 }));
      socket.send(JSON.stringify({ kind: 'command', command: { type: 'session.close', session, deeds: true } }));
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
        finish({ message: `hub reported an error: ${String(frame.message)}` });
        return;
      }
      if (frame.kind !== 'event' || !isObj(frame.event)) return;

      const envelope = frame.event;
      recent.push(envelope);
      if (recent.length > MAX_RECENT) recent.shift();

      const payload = envelope.payload;
      if (envelope.type === 'deed.recorded' && isObj(payload) && payload.closing === true) recorded += 1;
      if (envelope.type !== 'deeds.closing' || !isObj(payload) || payload.outcome === 'writing') return;
      if (payload.outcome !== 'recorded') {
        finish({ message: `the call at Close ended ${String(payload.outcome)}: ${String(payload.reason)}` });
      } else if (recorded === 0) {
        finish({ message: 'the call at Close says recorded, but no deed.recorded marked closing came before it' });
      } else {
        finish({ costUsd: payload.costUsd, recorded });
      }
    });

    socket.addEventListener('close', () => {
      finish({ message: 'the hub closed the /client connection before the call at Close finished' });
    });
  });
  if (closing.message) return closing.message;

  const rows = (await recentDeeds(base, node)).filter((deed) => isObj(deed) && deed.session === session);
  if (!rows.some((deed) => isObj(deed) && deed.kind === 'closing')) {
    return `the hub's Deeds list no Deed from the call at Close: ${JSON.stringify(rows)}`;
  }
  if (!rows.some((deed) => isObj(deed) && deed.kind === 'close' && String(deed.id).startsWith(`close:${session}:`))) {
    return `the hub's Deeds list no row for the call at Close: ${JSON.stringify(rows)}`;
  }
  const cost = typeof closing.costUsd === 'number' ? `$${closing.costUsd.toFixed(4)}` : 'an unreported cost';
  console.log(`smoke: the Quest closed and the call at Close recorded ${closing.recorded} Deed(s) for ${cost}`);
  return undefined;
}

/** The Library through the hub: write a Tome, read it back, write on its version, refuse a stale one. Why not, or nothing. */
async function checkLibrary(base: string, node: string): Promise<string | undefined> {
  const engines = (await (await fetch(`${base}/api/engines`)).json()) as unknown;
  const offered =
    Array.isArray(engines) && engines.some((row) => isObj(row) && row.node === node && isObj(row.library));
  if (!offered) {
    console.log("smoke: the Library was skipped: this Kingdom doesn't offer one (/api/engines shows no library)");
    return undefined;
  }

  const path = `smoke-${randomUUID().slice(0, 8)}.md`;
  const url = `${base}/api/nodes/${encodeURIComponent(node)}/library/tome`;
  const write = async (content: string, version: unknown) => {
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, content, base: version }),
    });
    return { status: response.status, body: (await response.json()) as unknown };
  };
  const versionOf = (body: unknown) => (isObj(body) && isObj(body.version) ? body.version : undefined);

  const created = await write('# Smoke\n', null);
  const first = versionOf(created.body);
  if (created.status !== 200 || !first) {
    return `writing a new Tome returned HTTP ${created.status}: ${JSON.stringify(created.body)}`;
  }
  console.log(`smoke: the Library took a new Tome, ${path}`);

  const read = await fetch(`${url}?path=${encodeURIComponent(path)}`);
  const body = (await read.json()) as unknown;
  const tome = isObj(body) ? body.tome : undefined;
  if (read.status !== 200 || !isObj(tome) || tome.content !== '# Smoke\n') {
    return `reading the Tome back returned HTTP ${read.status}: ${JSON.stringify(body)}`;
  }
  if (JSON.stringify(tome.version) !== JSON.stringify(first)) {
    return `the Tome's version ${JSON.stringify(tome.version)} is not the one the write returned, ${JSON.stringify(first)}`;
  }
  console.log('smoke: the Library read it back, content and version as written');

  const updated = await write('# Smoke, again\n', first);
  if (updated.status !== 200 || !versionOf(updated.body)) {
    return `writing on the Tome's version returned HTTP ${updated.status}: ${JSON.stringify(updated.body)}`;
  }
  console.log('smoke: the Library took a write on that version');

  const stale = await write('# Smoke, stale\n', first);
  if (stale.status !== 409) return `a write on the old version returned HTTP ${stale.status}, not 409`;
  console.log('smoke: the Library refused a write on the old version (409)');
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

    const deedsFailure = await checkDeeds(base, node, session, outcome.seq!);
    if (deedsFailure) {
      reportFailure(deedsFailure, recent);
      return;
    }

    const closeFailure = await closeWithDeeds(CLIENT_URL, base, node, session, recent);
    if (closeFailure) {
      reportFailure(closeFailure, recent);
      return;
    }

    const libraryFailure = await checkLibrary(base, node);
    if (libraryFailure) {
      reportFailure(libraryFailure, recent);
      return;
    }

    console.log(
      'smoke: PASS - result event arrived, crystal.txt exists, the turn reported it and was tallied, the Quest was named and left an Errand, and its Deeds were recorded at Close',
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  reportFailure(`unexpected error: ${errorMessage(error)}`, []);
});
