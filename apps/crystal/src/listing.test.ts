import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { cliInventory, LISTING_ARGS, listingEvents } from './listing.js';

/** What the CLI's `initialize` says, with the parts that must never leave the Kingdom. */
const INITIALIZE = {
  commands: [
    { name: 'deploy', description: 'Ship it', argumentHint: '<env>', builtin: false },
    { name: 'tools:lint', description: '', builtin: false },
    { name: 'compact', description: 'Clear the history', builtin: true },
  ],
  agents: [
    { name: 'claude', description: 'The main agent' },
    { name: 'reviewer', description: 'Reads diffs' },
  ],
  account: { email: 'someone@example.com', organization: 'Secret Org' },
  models: [{ value: 'model-x' }],
  pid: 4242,
};
const MCP_STATUS = {
  mcpServers: [
    {
      name: 'docs',
      status: 'connected',
      source: 'user',
      config: { headers: { authorization: 'Bearer hunter2' } },
      tools: [{ name: 'search' }, { name: 'read' }],
    },
    { name: 'claude.ai Mail', status: 'needs-auth', tools: [] },
  ],
};

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn();
  /** Answers each control request the way the CLI does. */
  answer(replies: Record<string, unknown>) {
    this.stdin.on('data', (chunk: Buffer) => {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        const { request_id, request } = JSON.parse(line) as { request_id: string; request: { subtype: string } };
        const reply = replies[request.subtype];
        if (reply === undefined) continue;
        this.say({ type: 'control_response', response: { subtype: 'success', request_id, response: reply } });
      }
    });
    return this;
  }
  say(value: unknown) {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }
}

const spawnOf = (child: FakeChild) => vi.fn(() => child) as never;

describe('listingEvents', () => {
  it('shapes the listing as `system/init` and `system/descriptions`', () => {
    const [init, descriptions] = listingEvents(INITIALIZE, MCP_STATUS);
    expect(init).toEqual({
      engine: 'claude',
      raw: {
        type: 'system',
        subtype: 'init',
        skills: ['deploy', 'tools:lint'],
        slash_commands: ['deploy', 'tools:lint', 'compact'],
        agents: ['claude', 'reviewer'],
        mcp_servers: [
          { name: 'docs', status: 'connected', source: 'user' },
          { name: 'claude.ai Mail', status: 'needs-auth' },
        ],
        tools: ['mcp__docs__search', 'mcp__docs__read'],
      },
    });
    expect(descriptions).toEqual({
      engine: 'claude',
      raw: {
        type: 'system',
        subtype: 'descriptions',
        descriptions: {
          deploy: 'Ship it',
          compact: 'Clear the history',
          claude: 'The main agent',
          reviewer: 'Reads diffs',
        },
      },
    });
  });

  it('carries nothing but names, descriptions and statuses off the Kingdom', () => {
    const text = JSON.stringify(listingEvents(INITIALIZE, MCP_STATUS));
    for (const secret of ['someone@example.com', 'Secret Org', 'model-x', 'hunter2', 'authorization', '4242']) {
      expect(text).not.toContain(secret);
    }
  });

  it('caps a long description, and reads a malformed reply as nothing', () => {
    const long = listingEvents({ commands: [{ name: 'a', description: 'x'.repeat(900) }] }, undefined);
    const raw = long[1]!.raw as { descriptions: { a: string } };
    expect(raw.descriptions.a.length).toBeLessThanOrEqual(300);
    const [init] = listingEvents('nonsense', { mcpServers: [7, { status: 'connected' }] });
    expect(init!.raw).toMatchObject({ skills: [], slash_commands: [], agents: [], mcp_servers: [], tools: [] });
  });
});

describe('cliInventory', () => {
  it('runs the plain CLI in the folder, sends no prompt and leaves no transcript', async () => {
    const child = new FakeChild().answer({ initialize: INITIALIZE, mcp_status: MCP_STATUS });
    const spawn = spawnOf(child);
    const sent: string[] = [];
    child.stdin.on('data', (chunk: Buffer) => sent.push(String(chunk)));
    const events = await cliInventory({ bin: 'claude', env: { HOME: '/h' }, spawn })('/w');
    expect(spawn).toHaveBeenCalledWith(
      'claude',
      LISTING_ARGS,
      expect.objectContaining({ cwd: '/w', env: { HOME: '/h' } }),
    );
    expect(LISTING_ARGS).toContain('--no-session-persistence');
    expect(LISTING_ARGS).not.toContain('--bare');
    expect(events).toHaveLength(2);
    expect(sent.join('')).not.toContain('"type":"user"');
    expect(child.stdin.writableEnded).toBe(true);
  });

  it('asks once for a folder already being listed', async () => {
    const child = new FakeChild();
    const spawn = spawnOf(child);
    const list = cliInventory({ bin: 'claude', env: {}, spawn });
    const both = [list('/w'), list('/w')];
    child.answer({ initialize: INITIALIZE, mcp_status: MCP_STATUS });
    await Promise.all(both);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('still lists the commands when a CLI refuses the MCP request', async () => {
    const child = new FakeChild().answer({ initialize: INITIALIZE });
    const listing = cliInventory({ bin: 'claude', env: {}, spawn: spawnOf(child) })('/w');
    await new Promise((resolve) => setTimeout(resolve, 5));
    child.say({
      type: 'control_response',
      response: { subtype: 'error', request_id: 'list-mcp', error: 'unknown subtype' },
    });
    const [init] = await listing;
    expect(init!.raw).toMatchObject({ skills: ['deploy', 'tools:lint'], mcp_servers: [] });
  });

  it('waits for servers still connecting: the CLI says none, then pending, then how they are', async () => {
    const child = new FakeChild();
    const replies = [{ mcpServers: [] }, { mcpServers: [{ name: 'docs', status: 'pending' }] }, MCP_STATUS];
    child.stdin.on('data', (chunk: Buffer) => {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        const { request_id, request } = JSON.parse(line) as { request_id: string; request: { subtype: string } };
        const response = request.subtype === 'initialize' ? INITIALIZE : (replies.shift() ?? MCP_STATUS);
        child.say({ type: 'control_response', response: { subtype: 'success', request_id, response } });
      }
    });
    const [init] = await cliInventory({ bin: 'claude', env: {}, spawn: spawnOf(child), mcpPollMs: 1 })('/w');
    expect(replies).toEqual([]);
    expect(init!.raw).toMatchObject({
      mcp_servers: expect.arrayContaining([expect.objectContaining({ status: 'connected' })]),
    });
  });

  it('stops waiting on a Kingdom with no servers, and on one that stays pending', async () => {
    const none = new FakeChild().answer({ initialize: INITIALIZE, mcp_status: { mcpServers: [] } });
    const options = { bin: 'claude', env: {}, mcpPollMs: 1, noServersMs: 5, mcpWaitMs: 20 };
    const [init] = await cliInventory({ ...options, spawn: spawnOf(none) })('/w');
    expect(init!.raw).toMatchObject({ mcp_servers: [] });

    const stuck = new FakeChild().answer({
      initialize: INITIALIZE,
      mcp_status: { mcpServers: [{ name: 'docs', status: 'pending' }] },
    });
    const [held] = await cliInventory({ ...options, spawn: spawnOf(stuck) })('/w');
    expect(held!.raw).toMatchObject({ mcp_servers: [{ name: 'docs', status: 'pending' }] });
  });

  it('fails when the CLI cannot start, and when it says nothing in time', async () => {
    const missing = new FakeChild();
    const failed = cliInventory({ bin: 'claude', env: {}, spawn: spawnOf(missing) })('/gone');
    missing.emit('error', new Error('ENOENT'));
    await expect(failed).rejects.toThrow();

    const quiet = new FakeChild();
    const timedOut = cliInventory({ bin: 'claude', env: {}, spawn: spawnOf(quiet), timeoutMs: 5 })('/w');
    await expect(timedOut).rejects.toThrow();
    expect(quiet.kill).toHaveBeenCalled();
  });

  it('turns a further folder away while too many are being listed', async () => {
    const list = cliInventory({ bin: 'claude', env: {}, spawn: (() => new FakeChild()) as never, timeoutMs: 30 });
    const running = ['/a', '/b', '/c'].map((cwd) => list(cwd));
    await expect(list('/d')).rejects.toThrow();
    await Promise.allSettled(running);
  });
});
