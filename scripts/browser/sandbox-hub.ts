/**
 * The world the browser tests run against (docs/LIBRARY.md, "Prove it first", item 3).
 *
 * Run directly (`tsx scripts/browser/sandbox-hub.ts`), it starts:
 * - two hubs from `buildServer`, open with no login and an in-memory store: `open`, as shipped, and `blocked`, built
 *   with a page CSP that keeps `frame-ancestors 'none'`, as a hub answer would by mistake;
 * - a fake Kingdom on each, answering Library reads from `fixtures/library/`;
 * - an "elsewhere" server, another site, that records every TCP connection and HTTP request it gets, and a UDP socket
 *   on the same port number that records every datagram (a STUN request from WebRTC);
 * - a control server the tests ask what elsewhere saw, and which Library pages each hub served with which
 *   `Sec-Fetch-*` headers.
 * It prints one JSON line with their addresses and stops when its stdin closes.
 *
 * Imported, its default export is Playwright's global setup: it runs the above as a child process and passes the
 * addresses to the tests in the environment.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const fixtures = path.join(here, 'fixtures/library');
const webDist = path.join(root, 'apps/web/dist');

/** The Kingdom both hubs name, and the Library folder its hello reports. */
export const NODE = 'tower';

/** The shipped page CSP, but with the mistake the test looks for: only `frame-ancestors 'none'` differs. */
const BLOCKED_PAGE_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; frame-ancestors 'none'";

/** What the tests see in the environment. */
export interface SandboxWorld {
  openHub: string;
  blockedHub: string;
  elsewhere: string;
  stun: string;
  control: string;
}

/** What the control server reports. */
export interface Seen {
  /** HTTP requests elsewhere got, as `METHOD /path` (`UPGRADE /path` for a WebSocket). */
  requests: string[];
  /** TCP connections elsewhere accepted, with or without a request (a preconnect makes one). */
  connections: number;
  /** UDP datagrams elsewhere got (a STUN binding request). */
  datagrams: number;
  /** The first datagram's first 20 bytes in hex (a STUN header: type, length, magic cookie, transaction id). */
  firstDatagram?: string;
  /** Each request for a Library page: which hub, and the `Sec-Fetch-*` headers it came with. */
  pages: { hub: string; url: string; dest?: string; site?: string }[];
}

const listening = (server: Server, host: string) =>
  new Promise<number>((resolve) => server.listen(0, host, () => resolve((server.address() as AddressInfo).port)));

function tomeFor(file: string, fill: (text: string) => string) {
  const full = path.resolve(fixtures, file);
  if (!full.startsWith(fixtures + path.sep) || !existsSync(full)) return undefined;
  const content = fill(readFileSync(full, 'utf8'));
  const kind = file.endsWith('.html') ? 'html' : 'md';
  const version = {
    size: Buffer.byteLength(content),
    mtimeMs: statSync(full).mtimeMs,
    hash: createHash('sha256').update(content).digest('hex'),
  };
  return { path: file, kind, content, encoding: 'utf8', truncated: false, version };
}

/** A Kingdom with a Library: says hello, then answers each read from the fixtures with the placeholders filled. */
async function fakeKingdom(hub: string, fill: (text: string) => string): Promise<WebSocket> {
  const socket = new WebSocket(`${hub.replace(/^http/, 'ws')}/node`);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error(`no /node socket at ${hub}`)), { once: true });
  });
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(String(event.data)) as { kind: string; requestId?: string; path?: string };
    if (frame.kind !== 'library-read' || !frame.requestId || !frame.path) return;
    const tome = tomeFor(frame.path, fill);
    socket.send(
      JSON.stringify(
        tome
          ? { kind: 'library-answer', requestId: frame.requestId, ok: true, tome }
          : { kind: 'library-answer', requestId: frame.requestId, ok: false, reason: 'gone' },
      ),
    );
  });
  socket.send(JSON.stringify({ kind: 'hello', node: NODE, library: { dir: '/library' } }));
  return socket;
}

async function main(): Promise<void> {
  if (!existsSync(path.join(webDist, 'mermaid-frame.html'))) {
    // Through the pnpm that runs this, when it says which; else the one on the PATH.
    const pnpm = process.env.npm_execpath;
    const [command, args] =
      pnpm?.endsWith('.js') || pnpm?.endsWith('.cjs') ? [process.execPath, [pnpm]] : [pnpm ?? 'pnpm', []];
    execFileSync(command, [...args, '--filter', './apps/web', 'build'], { cwd: root, stdio: ['ignore', 2, 2] });
  }
  const { buildServer } = await import('../../apps/airship/src/server.js');
  const { openStore } = await import('../../apps/airship/src/store.js');

  const seen: Seen = { requests: [], connections: 0, datagrams: 0, pages: [] };

  // Elsewhere: on every interface and both address families, so `localhost` reaches it whichever it resolves to. It is
  // named `localhost` and the hubs `127.0.0.1`, so it's another site as well as another origin.
  const elsewhere = createServer((request, response) => {
    seen.requests.push(`${request.method} ${request.url}`);
    response.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }).end('elsewhere');
  });
  // A WebSocket's opening request comes as an upgrade, not a request: recorded the same way, then refused.
  elsewhere.on('upgrade', (request, socket) => {
    seen.requests.push(`UPGRADE ${request.url}`);
    socket.destroy();
  });
  elsewhere.on('connection', () => (seen.connections += 1));
  const elsewherePort = await listening(elsewhere, '::');
  const udp = createSocket({ type: 'udp6', ipv6Only: false });
  udp.on('message', (message) => {
    seen.datagrams += 1;
    seen.firstDatagram ??= message.subarray(0, 20).toString('hex');
  });
  const stunPort = await new Promise<number>((resolve) => udp.bind(0, '::', () => resolve(udp.address().port)));

  const elsewhereUrl = `http://localhost:${elsewherePort}`;
  const fill = (text: string) =>
    text.replaceAll('__ELSEWHERE__', elsewhereUrl).replaceAll('__STUN__', `localhost:${stunPort}`);

  const hubs: { name: string; url: string; close: () => Promise<void>; kingdom: WebSocket }[] = [];
  for (const [name, libraryPageCsp] of [
    ['open', undefined],
    ['blocked', BLOCKED_PAGE_CSP],
  ] as const) {
    const app = await buildServer({ store: openStore(':memory:'), webRoot: webDist, libraryPageCsp });
    app.addHook('onRequest', async (request) => {
      if (!request.url.includes('/library/page')) return;
      const header = (key: string) => request.headers[key] as string | undefined;
      seen.pages.push({ hub: name, url: request.url, dest: header('sec-fetch-dest'), site: header('sec-fetch-site') });
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    hubs.push({ name, url, close: () => app.close(), kingdom: await fakeKingdom(url, fill) });
  }

  // Wait until both hubs know the Kingdom keeps a Library, so a test's first request doesn't race the hello.
  for (const hub of hubs) {
    for (let tries = 0; ; tries++) {
      const engines = (await (await fetch(`${hub.url}/api/engines`)).json()) as { node: string; library?: unknown }[];
      if (engines.some((row) => row.node === NODE && row.library)) break;
      if (tries > 100) throw new Error(`the fake Kingdom never reached the ${hub.name} hub`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  const control = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/reset') {
      Object.assign(seen, { requests: [], connections: 0, datagrams: 0, firstDatagram: undefined, pages: [] });
      response.writeHead(204).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(seen));
  });
  const controlPort = await listening(control, '127.0.0.1');

  const world: SandboxWorld = {
    openHub: hubs[0]!.url,
    blockedHub: hubs[1]!.url,
    elsewhere: elsewhereUrl,
    stun: `localhost:${stunPort}`,
    control: `http://127.0.0.1:${controlPort}`,
  };
  process.stdout.write(`${JSON.stringify(world)}\n`);

  const stop = async () => {
    for (const hub of hubs) {
      hub.kingdom.close();
      await hub.close();
    }
    elsewhere.closeAllConnections();
    elsewhere.close();
    control.close();
    udp.close();
    process.exit(0);
  };
  process.stdin.on('end', () => void stop());
  process.stdin.resume();
  process.on('SIGTERM', () => void stop());
}

/** Playwright's global setup: starts this file as a child process and hands its addresses to the tests. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const child = spawn(path.join(root, 'node_modules/.bin/tsx'), [fileURLToPath(import.meta.url)], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const line = await new Promise<string>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout! });
    lines.once('line', resolve);
    child.once('exit', (code) => reject(new Error(`sandbox-hub exited (${code}) before it was ready`)));
  });
  const world = JSON.parse(line) as SandboxWorld;
  process.env.SANDBOX_WORLD = JSON.stringify(world);
  return async () => {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.stdin!.end();
    await exited;
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
