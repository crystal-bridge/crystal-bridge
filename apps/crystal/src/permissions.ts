import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { ErrandBody, MAX_ERRANDS_PER_TURN, QuestTitle, type QuestTitledPayload } from '@crystal-bridge/protocol';
import { z } from 'zod';

/**
 * The documented `--permission-prompt-tool` decision shape: a single text content
 * block whose text is this JSON, returned to the `claude` CLI.
 */
/** `updatedInput` replaces the tool's input, e.g. AskUserQuestion's input with the answers added. */
export type PermissionDecision = { behavior: 'allow'; updatedInput?: unknown } | { behavior: 'deny'; message: string };

/** How long the CLI lets a call to this server stay silent, which is its default of 300 s until told otherwise. */
const MCP_IDLE_MS = 86_400_000;

/** The `--mcp-config` for a Quest. A human may take far longer to answer than the CLI waits by default, and neither `MCP_TOOL_TIMEOUT` nor stream traffic extends it. */
export function mcpConfig(url: string): string {
  return JSON.stringify({ mcpServers: { crystal: { type: 'http', url, timeout: MCP_IDLE_MS } } });
}

/** What the MCP tool call is asking a human to decide. */
export interface PermissionRequest {
  session: string;
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string;
}

/**
 * Resolves (or rejects) once a human has answered. May stay pending for minutes,
 * so the server sets no request timeout while this is outstanding.
 */
export type OnPermissionRequest = (request: PermissionRequest) => Promise<PermissionDecision>;

/** The `summon` tool's work (`summons.ts`). The description is asked for each time, as it names the Kingdom's machines. */
export interface SummonTool {
  description(): string;
  call(session: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface CreatePermissionServerOptions {
  port: number;
  host?: string;
  onRequest: OnPermissionRequest;
  /** Offers Quests the `summon` tool. */
  summon?: SummonTool;
  /**
   * Offers Quests the `title` tool (#287): passes on the name a Quest gives itself. Returns why it was refused, if it
   * was, as the tool's error.
   */
  onTitle?: (session: string, title: QuestTitledPayload) => string | undefined;
  /**
   * Offers Quests the `errand` tool (#288): passes on a step the user must take. Returns the new Errand's id, or why it
   * was refused, as the tool's error.
   */
  onErrand?: (
    session: string,
    errand: { title: string; body: string },
  ) => { ok: true; id: string } | { ok: false; reason: string };
  /** Served on `GET /status` (localhost only), e.g. so a deploy can wait until no session is mid-turn. */
  status?: () => unknown;
  /** Hook calls other than PermissionRequest from interactive sessions (SessionStart, Stop, Notification). */
  onHook?: (session: string, event: string, body: Record<string, unknown>) => void;
}

export interface PermissionServer {
  port: number;
  url(session: string): string;
  /** Where an interactive session's hooks POST, without the event name. */
  hookUrl(session: string): string;
  close(): Promise<void>;
}

const ApproveInputShape = {
  tool_name: z.string(),
  input: z.record(z.string(), z.unknown()),
  tool_use_id: z.string().optional(),
};

const SummonInputShape = {
  action: z.enum(['start', 'status', 'cancel', 'machines']),
  summon: z.string().optional().describe('start: which machine'),
  command: z.string().optional().describe('start: what to run'),
  onFinish: z
    .enum(['notify', 'wake'])
    .optional()
    .describe('start, required: notify tells the user and spends nothing; wake sends you the result, costing a turn'),
  name: z.string().optional().describe('start: what to call this Cast; defaults to the first word of the command'),
  cwd: z.string().optional().describe('start: where to run it; defaults to the home folder'),
  cast: z.string().optional().describe('status: one Cast, or leave it out for all of this Quest; cancel: which Cast'),
};

const titleText = QuestTitle;
const TitleInputShape = {
  title: titleText.describe('A short quest name in a fantasy-RPG voice, e.g. "The Siege of the Flaky Smoke Test"'),
  plain: titleText.describe('The same in plain words, e.g. "Fix the flaky smoke test"'),
};

/** The `title` tool as the CLI names it, for allowing it up front. */
export const TITLE_TOOL = 'mcp__crystal__title';

/**
 * What every Quest's system prompt asks, through `--append-system-prompt`. The CLI defers MCP tools behind ToolSearch, so
 * the model never reads the tool's own description unless something tells it to load the tool (test/fixtures/README.md).
 */
export const TITLE_INSTRUCTION =
  'Required: before any other tool call in your first turn, load mcp__crystal__title with ToolSearch and call it to ' +
  'name this session (a fantasy-RPG quest name and a plain one). Call it once: later turns keep that name.';

/**
 * What the `title` tool asks of a Quest. Crystal allows the tool itself, so a call never raises a permission card. The
 * hub keeps only a Quest's first title, so nothing here invites a second call.
 */
export const TITLE_DESCRIPTION =
  "Name this session for the user's list of sessions. Call it once, as soon as you understand what the user is " +
  'asking. Keep each name under about 50 characters. The first name stays until the user renames the session.';

const ErrandInputShape = {
  title: QuestTitle.describe('One line: the step, e.g. "Try the new export by hand"'),
  body: ErrandBody.default('').describe('Markdown: how to do it; commands in fenced code blocks'),
};

/** The `errand` tool as the CLI names it, for allowing it up front. */
export const ERRAND_TOOL = 'mcp__crystal__errand';

/** Crystal's tools a Quest may call without asking: allowed up front on both engines. */
export const QUEST_TOOLS = [TITLE_TOOL, ERRAND_TOOL] as const;

/** The Errand line of every new Quest's system prompt (the CLI defers MCP tools, test/fixtures/README.md). */
export const ERRAND_INSTRUCTION =
  'When you finish with steps the user must take themselves (test something by hand, run a command, install an ' +
  'update), load mcp__crystal__errand with ToolSearch and leave one Errand for each, then still say them in your reply.';

export const ERRAND_DESCRIPTION =
  'Leave the user a step to take after this turn, kept outside the chat until they tick it off. One call per step, ' +
  `at most ${MAX_ERRANDS_PER_TURN} a turn. Only for what the user must do: if you can do the step, do it instead. ` +
  'Answers with its id.';

/** The one `--append-system-prompt` value a new Quest or fork gets: the CLI keeps it for every later resume. */
export const QUEST_PROMPT = `${TITLE_INSTRUCTION} ${ERRAND_INSTRUCTION}`;

function buildMcpServer(
  session: string,
  onRequest: OnPermissionRequest,
  summon?: SummonTool,
  onTitle?: CreatePermissionServerOptions['onTitle'],
  onErrand?: CreatePermissionServerOptions['onErrand'],
): McpServer {
  const server = new McpServer({ name: 'crystal-permissions', version: '0.0.0' });

  server.registerTool(
    'approve',
    {
      description: "Ask a human to allow or deny a tool call from Claude's session.",
      inputSchema: ApproveInputShape,
    },
    async (args) => {
      const decision = await onRequest({
        session,
        requestId: randomUUID(),
        toolName: args.tool_name,
        input: args.input,
        toolUseId: args.tool_use_id,
      });

      const result =
        decision.behavior === 'allow'
          ? { behavior: 'allow' as const, updatedInput: decision.updatedInput ?? args.input }
          : { behavior: 'deny' as const, message: decision.message };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    },
  );

  if (summon) {
    server.registerTool(
      'summon',
      { description: summon.description(), inputSchema: SummonInputShape },
      async (args) => {
        try {
          const result = await summon.call(session, args);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          return { content: [{ type: 'text' as const, text }], isError: true };
        }
      },
    );
  }

  if (onTitle) {
    server.registerTool('title', { description: TITLE_DESCRIPTION, inputSchema: TitleInputShape }, async (args) => {
      const refused = onTitle(session, { title: args.title, plain: args.plain });
      return refused
        ? { content: [{ type: 'text' as const, text: refused }], isError: true }
        : { content: [{ type: 'text' as const, text: 'Named.' }] };
    });
  }

  if (onErrand) {
    server.registerTool('errand', { description: ERRAND_DESCRIPTION, inputSchema: ErrandInputShape }, async (args) => {
      const result = onErrand(session, { title: args.title, body: args.body });
      return result.ok
        ? { content: [{ type: 'text' as const, text: `Left Errand ${result.id}.` }] }
        : { content: [{ type: 'text' as const, text: result.reason }], isError: true };
    });
  }

  return server;
}

export async function createPermissionServer(options: CreatePermissionServerOptions): Promise<PermissionServer> {
  const host = options.host ?? '127.0.0.1';
  const onRequest = options.onRequest;

  const app = express();
  // Only the node's own `claude` processes and deploy scripts call this port. A web page in the user's browser can
  // reach 127.0.0.1 too (always sending an Origin), and a rebound DNS name can reach it with a foreign Host: refuse
  // both before anything reads the body.
  const ownHosts = new Set<string>();
  app.use((req, res, next) => {
    if (req.headers.origin !== undefined || !ownHosts.has((req.headers.host ?? '').toLowerCase())) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  });
  // A Write or Edit carries the whole file in its input; the 100kb default rejects real ones.
  app.use(express.json({ limit: '50mb' }));

  app.post('/mcp/:session', async (req, res) => {
    const session = req.params.session as string;
    const mcpServer = buildMcpServer(session, onRequest, options.summon, options.onTitle, options.onErrand);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on('close', () => {
      void transport.close();
      void mcpServer.close();
    });

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: error instanceof Error ? error.message : 'internal error' },
          id: null,
        });
      }
    }
  });

  // The interactive engine's hooks (interactive.ts): each POSTs its documented JSON input here. A PermissionRequest
  // waits on the same human decision as the MCP tool and answers in the hook's documented decision shape.
  app.post('/hook/:session/:event', async (req, res) => {
    const session = req.params.session as string;
    const event = req.params.event as string;
    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    if (event === 'StatusLine') {
      // A statusline command prints what its terminal shows; nobody sees that terminal, so print nothing.
      options.onHook?.(session, event, body);
      res.type('text/plain').send('');
      return;
    }
    if (event !== 'PermissionRequest') {
      options.onHook?.(session, event, body);
      res.json({});
      return;
    }
    const input = (typeof body.tool_input === 'object' && body.tool_input !== null ? body.tool_input : {}) as Record<
      string,
      unknown
    >;
    const decision = await onRequest({
      session,
      requestId: randomUUID(),
      toolName: typeof body.tool_name === 'string' ? body.tool_name : 'unknown',
      input,
      ...(typeof body.tool_use_id === 'string' ? { toolUseId: body.tool_use_id } : {}),
    });
    res.json({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision:
          decision.behavior === 'allow'
            ? { behavior: 'allow', updatedInput: decision.updatedInput ?? input }
            : { behavior: 'deny', message: decision.message },
      },
    });
  });

  app.get('/status', (_req, res) => {
    res.json(options.status?.() ?? {});
  });

  // Stateless mode: there is no server-held session to resume (GET) or terminate (DELETE).
  app.get('/mcp/:session', (_req, res) => {
    res.status(405).json({ error: 'method not allowed' });
  });
  app.delete('/mcp/:session', (_req, res) => {
    res.status(405).json({ error: 'method not allowed' });
  });

  const httpServer = await new Promise<HttpServer>((resolve, reject) => {
    const server: HttpServer = app.listen(options.port, host);
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });

  // A human may take minutes to answer a permission prompt; don't let Node's
  // default request/header timeouts cut that connection short.
  httpServer.requestTimeout = 0;
  httpServer.headersTimeout = 0;
  httpServer.timeout = 0;

  const address = httpServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  for (const name of [host, '127.0.0.1', 'localhost', '[::1]']) ownHosts.add(`${name}:${port}`.toLowerCase());

  return {
    port,
    url(session: string) {
      return `http://${host}:${port}/mcp/${session}`;
    },
    hookUrl(session: string) {
      return `http://${host}:${port}/hook/${session}`;
    },
    async close() {
      httpServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
