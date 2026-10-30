/**
 * `pnpm demo`: the app with a scripted world in it, for screenshots, recordings and a look around. It starts a throwaway
 * hub and the web dev server, then plays three invented Kingdoms over the real node protocol. No `claude` runs and
 * nothing is kept. Approve works: the Quest carries on to its result.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeCommand, PROTOCOL_VERSION } from '../packages/protocol/src/index.js';
import { demoWorld, type DemoKingdom } from './demo-scenes.js';

const PORT = '7700';
const HUB = `ws://127.0.0.1:${PORT}/node`;

const dir = mkdtempSync(join(tmpdir(), 'crystal-bridge-demo-'));
const children: ChildProcess[] = [];
// A Quest's shell carries its Kingdom's settings; the demo must never aim at the real hub.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CRYSTAL|AIRSHIP)_/.test(key)));

function run(cwd: string, command: string, args: string[], extra: NodeJS.ProcessEnv = {}): void {
  children.push(spawn(command, args, { cwd, env: { ...env, ...extra }, stdio: 'inherit' }));
}

function stop(): never {
  for (const child of children) child.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const tsx = join(process.cwd(), 'node_modules/.bin/tsx');
run('apps/airship', tsx, ['src/main.ts'], { AIRSHIP_DEV: '1', AIRSHIP_PORT: PORT, AIRSHIP_DB: join(dir, 'demo.db') });
run('apps/web', 'node_modules/.bin/vite', ['--port', '5173', '--strictPort']);

function connect(): Promise<WebSocket> {
  return new Promise((resolve) => {
    const attempt = (): void => {
      const socket = new WebSocket(HUB);
      socket.addEventListener('open', () => resolve(socket), { once: true });
      socket.addEventListener('error', () => setTimeout(attempt, 200), { once: true });
    };
    attempt();
  });
}

const world = demoWorld();

async function bringUp({ id, projects, found }: DemoKingdom): Promise<void> {
  const socket = await connect();
  const send = (frame: unknown): void => socket.send(JSON.stringify(frame));
  send({ kind: 'hello', node: id, protocol: PROTOCOL_VERSION, engines: ['stream', 'interactive'], release: '0.2.0' });
  send({ kind: 'cli', version: '2.1.320' });
  send({ kind: 'projects', projects });
  send({ kind: 'external', sessions: found });
  for (const story of world.stories) {
    if (story.node === id) story.events.forEach(send);
  }
  socket.addEventListener('message', ({ data }) => {
    const command = NodeCommand.safeParse(JSON.parse(String(data)));
    if (!command.success || command.data.type !== 'permission.answer' || command.data.behavior !== 'allow') return;
    world.onApprove.get(command.data.requestId)?.().forEach(send);
  });
}

await Promise.all(world.kingdoms.map(bringUp));
await fetch(`http://127.0.0.1:${PORT}/api/appearance`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(world.appearance),
});
console.log('\n[demo] open http://localhost:5173 (Ctrl-C ends it; nothing is kept)\n');
