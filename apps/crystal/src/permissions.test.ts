import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createPermissionServer,
  type PermissionDecision,
  type PermissionRequest,
  type PermissionServer,
} from './permissions.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function connectClient(server: PermissionServer, session: string): Promise<Client> {
  const client = new Client({ name: 'crystal-test-client', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(server.url(session)));
  await client.connect(transport);
  return client;
}

describe('createPermissionServer', () => {
  let server: PermissionServer;
  let client: Client;
  let session: string;
  let requests: PermissionRequest[];
  let nextDecision: Deferred<PermissionDecision>;

  beforeEach(async () => {
    requests = [];
    nextDecision = defer();

    server = await createPermissionServer({
      port: 0,
      onRequest: async (req) => {
        requests.push(req);
        return nextDecision.promise;
      },
    });
    session = randomUUID();
    client = await connectClient(server, session);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it('lists exactly one tool named approve', async () => {
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(['approve']);
  });

  it('invokes onRequest with the session, a request id, and the mapped fields', async () => {
    nextDecision.resolve({ behavior: 'allow' });

    await client.callTool({
      name: 'approve',
      arguments: { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 't1' },
    });

    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request).toMatchObject({
      session,
      toolName: 'Bash',
      input: { command: 'ls' },
      toolUseId: 't1',
    });
    expect(typeof request?.requestId).toBe('string');
    expect(request?.requestId.length).toBeGreaterThan(0);
  });

  it('returns an allow decision with the original input echoed back', async () => {
    nextDecision.resolve({ behavior: 'allow' });

    const result = await client.callTool({
      name: 'approve',
      arguments: { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 't1' },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe('text');
    expect(JSON.parse(content[0]?.text ?? '')).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'ls' },
    });
  });

  it('returns the answered input when the decision carries one, e.g. for AskUserQuestion', async () => {
    const questions = [{ question: 'Which color?', options: [{ label: 'Red' }, { label: 'Blue' }] }];
    nextDecision.resolve({ behavior: 'allow', updatedInput: { questions, answers: { 'Which color?': 'Blue' } } });

    const result = await client.callTool({
      name: 'approve',
      arguments: { tool_name: 'AskUserQuestion', input: { questions }, tool_use_id: 't2' },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0]?.text ?? '')).toEqual({
      behavior: 'allow',
      updatedInput: { questions, answers: { 'Which color?': 'Blue' } },
    });
  });

  it('returns a deny decision with the message', async () => {
    nextDecision.resolve({ behavior: 'deny', message: 'no' });

    const result = await client.callTool({
      name: 'approve',
      arguments: { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 't1' },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0]?.text ?? '')).toEqual({
      behavior: 'deny',
      message: 'no',
    });
  });

  it('stays pending until onRequest resolves', async () => {
    let settled = false;
    const callPromise = client
      .callTool({
        name: 'approve',
        arguments: { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 't1' },
      })
      .then((result) => {
        settled = true;
        return result;
      });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);

    nextDecision.resolve({ behavior: 'allow' });
    await callPromise;
    expect(settled).toBe(true);
  });

  it('accepts a ~1MB tool input (e.g. a large Write) and passes it to onRequest', async () => {
    nextDecision.resolve({ behavior: 'allow' });
    const content = 'x'.repeat(1024 * 1024);

    const result = await client.callTool({
      name: 'approve',
      arguments: { tool_name: 'Write', input: { file_path: '/tmp/big.txt', content }, tool_use_id: 't1' },
    });

    expect(requests).toHaveLength(1);
    expect((requests[0]?.input as { content: string }).content).toHaveLength(content.length);
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(JSON.parse(text).behavior).toBe('allow');
  });
});

describe('Crystal status endpoint', () => {
  it('serves the node status on GET /status, and an empty object without a status source', async () => {
    const withStatus = await createPermissionServer({
      port: 0,
      onRequest: async () => ({ behavior: 'allow' }),
      status: () => ({ node: 'n', sessions: 1, busy: ['s'] }),
    });
    const bare = await createPermissionServer({ port: 0, onRequest: async () => ({ behavior: 'allow' }) });
    try {
      expect(await (await fetch(`http://127.0.0.1:${withStatus.port}/status`)).json()).toEqual({
        node: 'n',
        sessions: 1,
        busy: ['s'],
      });
      expect(await (await fetch(`http://127.0.0.1:${bare.port}/status`)).json()).toEqual({});
    } finally {
      await withStatus.close();
      await bare.close();
    }
  });
});

/** A raw request, so the test can set Host and Origin the way a browser page (or a rebound DNS name) would. */
function rawRequest(port: number, method: string, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

describe('Crystal local port, against browsers', () => {
  it('refuses requests from a web page (an Origin) or for another host name (DNS rebinding), and serves its own', async () => {
    const hooks: string[] = [];
    const server = await createPermissionServer({
      port: 0,
      onRequest: async () => ({ behavior: 'allow' }),
      onHook: (_session, event) => hooks.push(event),
      status: () => ({ busy: [] }),
    });
    const own = `127.0.0.1:${server.port}`;
    try {
      const hook = `/hook/${randomUUID()}/Stop`;
      expect(await rawRequest(server.port, 'POST', hook, { host: own, origin: 'https://evil.example' })).toBe(403);
      expect(await rawRequest(server.port, 'POST', hook, { host: `evil.example:${server.port}` })).toBe(403);
      expect(await rawRequest(server.port, 'GET', '/status', { host: `evil.example:${server.port}` })).toBe(403);
      expect(hooks).toEqual([]);
      expect(await rawRequest(server.port, 'POST', hook, { host: own })).toBe(200);
      expect(await rawRequest(server.port, 'GET', '/status', { host: `localhost:${server.port}` })).toBe(200);
      expect(hooks).toEqual(['Stop']);
    } finally {
      await server.close();
    }
  });
});

describe('Crystal hook endpoint (interactive engine)', () => {
  it('answers a PermissionRequest hook in the documented decision shape, via the same onRequest', async () => {
    const requests: PermissionRequest[] = [];
    const server = await createPermissionServer({
      port: 0,
      onRequest: async (req) => {
        requests.push(req);
        return req.toolName === 'Bash' ? { behavior: 'allow' } : { behavior: 'deny', message: 'no' };
      },
    });
    const session = randomUUID();
    const post = (body: unknown) =>
      fetch(`http://127.0.0.1:${server.port}/hook/${session}/PermissionRequest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json());
    try {
      const input = { command: 'touch x' };
      expect(await post({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: input })).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow', updatedInput: input },
        },
      });
      expect(requests[0]).toMatchObject({ session, toolName: 'Bash', input });
      expect(await post({ hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: {} })).toEqual({
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'no' } },
      });
    } finally {
      await server.close();
    }
  });

  it('hands other hook events to onHook and answers with an empty object', async () => {
    const seen: [string, string, unknown][] = [];
    const server = await createPermissionServer({
      port: 0,
      onRequest: async () => ({ behavior: 'allow' }),
      onHook: (session, event, body) => seen.push([session, event, body]),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/hook/s1/Stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ last_assistant_message: 'hi' }),
      });
      expect(await res.json()).toEqual({});
      expect(seen).toEqual([['s1', 'Stop', { last_assistant_message: 'hi' }]]);
      expect(server.hookUrl('s1')).toBe(`http://127.0.0.1:${server.port}/hook/s1`);
    } finally {
      await server.close();
    }
  });

  it('answers a statusline call with empty text, which is what its terminal shows', async () => {
    const seen: string[] = [];
    const server = await createPermissionServer({
      port: 0,
      onRequest: async () => ({ behavior: 'allow' }),
      onHook: (_session, event) => seen.push(event),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/hook/s1/StatusLine`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cost: { total_cost_usd: 0.1 } }),
      });
      expect(await res.text()).toBe('');
      expect(seen).toEqual(['StatusLine']);
    } finally {
      await server.close();
    }
  });
});
