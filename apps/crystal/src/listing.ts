import { spawn as nodeSpawn } from 'node:child_process';
import type { ClaudeEventPayload } from './session.js';

/**
 * The Inventory before a Quest exists. `system/init` only comes with a first turn, but the CLI answers these two control
 * requests with no prompt: no turn, no plan usage. The answers also carry the account, model names and each server's
 * config, so `listingEvents` copies out names, descriptions and statuses, and nothing else leaves the Kingdom.
 */
export const LISTING_ARGS: readonly string[] = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--no-session-persistence',
];

const INITIALIZE_ID = 'list-initialize';
const MCP_ID = 'list-mcp';
/** Starting the CLI connects its MCP servers, which can be slow; the hub waits a little longer than this. */
const LIST_TIMEOUT_MS = 15_000;
/** After this, a CLI that ignored its stdin closing is stopped. */
const EXIT_GRACE_MS = 2_000;
/** MCP servers connect in the background: at first the CLI lists none, then `pending`, then how each went. */
const MCP_POLL_MS = 250;
/** How long to take "no servers" at its word, since the first answers say that on any Kingdom. */
const NO_SERVERS_MS = 1_000;
/** A server slower than this shows as pending. */
const MCP_WAIT_MS = 5_000;
/** Lists running at once, so typing a path can't start a crowd of processes. */
const MAX_LISTS = 3;
/** The same cap the file-read descriptions have. */
const MAX_DESCRIPTION = 300;

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null;
const list = (value: unknown): Obj[] => (Array.isArray(value) ? value.filter(isObj) : []);
const named = (value: unknown): (Obj & { name: string })[] =>
  list(value).filter((item): item is Obj & { name: string } => typeof item.name === 'string' && item.name !== '');

const capped = (text: string) =>
  text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…` : text;

/** The prefix the CLI gives a server's tools, as the Inventory's tool count expects it. */
const toolPrefix = (server: string) => `mcp__${server.replace(/[^a-zA-Z0-9_-]/g, '_')}__`;

/** The two answers, as the `system/init` and `system/descriptions` lines the client's Inventory reads. */
export function listingEvents(initialize: unknown, mcpStatus: unknown): ClaudeEventPayload[] {
  const reply = isObj(initialize) ? initialize : {};
  const commands = named(reply.commands);
  const agents = named(reply.agents);
  const servers = named(isObj(mcpStatus) ? mcpStatus.mcpServers : undefined);
  const descriptions: Record<string, string> = {};
  for (const { name, description } of [...commands, ...agents]) {
    if (typeof description === 'string' && description && !(name in descriptions)) {
      descriptions[name] = capped(description);
    }
  }
  const init = {
    type: 'system',
    subtype: 'init',
    skills: commands.filter((command) => command.builtin !== true).map(({ name }) => name),
    slash_commands: commands.map(({ name }) => name),
    agents: agents.map(({ name }) => name),
    mcp_servers: servers.map(({ name, status, source }) => ({
      name,
      status: typeof status === 'string' ? status : 'unknown',
      ...(typeof source === 'string' ? { source } : {}),
    })),
    tools: servers.flatMap(({ name, tools }) => named(tools).map((tool) => `${toolPrefix(name)}${tool.name}`)),
  };
  return [
    { engine: 'claude', raw: init },
    { engine: 'claude', raw: { type: 'system', subtype: 'descriptions', descriptions } },
  ];
}

export interface CliInventoryOptions {
  bin: string;
  env: NodeJS.ProcessEnv;
  spawn?: typeof nodeSpawn;
  timeoutMs?: number;
  mcpPollMs?: number;
  noServersMs?: number;
  mcpWaitMs?: number;
}

/** Lists a folder with a short-lived run of the unmodified CLI; a folder already being listed shares that run. */
export function cliInventory(options: CliInventoryOptions): (cwd: string) => Promise<ClaudeEventPayload[]> {
  const running = new Map<string, Promise<ClaudeEventPayload[]>>();
  return (cwd) => {
    const current = running.get(cwd);
    if (current) return current;
    if (running.size >= MAX_LISTS) return Promise.reject(new Error('too many lists running'));
    const listing = listOnce(options, cwd).finally(() => running.delete(cwd));
    running.set(cwd, listing);
    return listing;
  };
}

function listOnce(
  {
    bin,
    env,
    spawn = nodeSpawn,
    timeoutMs = LIST_TIMEOUT_MS,
    mcpPollMs = MCP_POLL_MS,
    noServersMs = NO_SERVERS_MS,
    mcpWaitMs = MCP_WAIT_MS,
  }: CliInventoryOptions,
  cwd: string,
): Promise<ClaudeEventPayload[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...LISTING_ARGS], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '';
    let settled = false;
    let initialize: unknown;
    let mcpStatus: unknown;
    let listedAt = 0;
    let pollTimer: NodeJS.Timeout | undefined;
    let exitTimer: NodeJS.Timeout | undefined;

    const ask = (id: string, subtype: string) =>
      child.stdin?.write(`${JSON.stringify({ type: 'control_request', request_id: id, request: { subtype } })}\n`);
    const stop = () => {
      child.stdin?.end();
      exitTimer = setTimeout(() => child.kill(), EXIT_GRACE_MS);
      exitTimer.unref?.();
    };
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(pollTimer);
      finish();
    };
    // The commands are the list: a CLI that won't say how its servers are still lists those.
    const finished = () => settle(() => resolve(listingEvents(initialize, mcpStatus)));
    const failed = (reason: string) => settle(() => reject(new Error(reason)));

    const timer = setTimeout(() => {
      child.kill();
      if (initialize === undefined) failed('the CLI did not list in time');
      else finished();
    }, timeoutMs);

    const onLine = (line: string) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!isObj(message) || message.type !== 'control_response' || !isObj(message.response)) return;
      const { request_id: id, subtype, response } = message.response;
      if (id !== INITIALIZE_ID && id !== MCP_ID) return;
      if (id === INITIALIZE_ID) {
        if (subtype !== 'success') {
          stop();
          failed('the CLI refused to list');
          return;
        }
        initialize = response;
        listedAt = Date.now();
        ask(MCP_ID, 'mcp_status');
        return;
      }
      if (subtype === 'success') mcpStatus = response;
      const servers = named(isObj(mcpStatus) ? mcpStatus.mcpServers : undefined);
      const waited = Date.now() - listedAt;
      const unsettled = servers.length === 0 ? waited < noServersMs : servers.some((s) => s.status === 'pending');
      if (subtype === 'success' && unsettled && waited < mcpWaitMs) {
        pollTimer = setTimeout(() => ask(MCP_ID, 'mcp_status'), mcpPollMs);
        return;
      }
      stop();
      finished();
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      lines.filter(Boolean).forEach(onLine);
    });
    child.on('error', () => failed('the CLI could not start'));
    child.on('close', () => {
      clearTimeout(exitTimer);
      if (initialize === undefined) failed('the CLI ended without listing');
      else finished();
    });
    // A CLI that has gone raises EPIPE here; `close` reports it.
    child.stdin?.on('error', () => {});
    ask(INITIALIZE_ID, 'initialize');
  });
}
