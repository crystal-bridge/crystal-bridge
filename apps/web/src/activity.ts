import type { Envelope } from '@crystal-bridge/protocol';
import type { StepKind } from './theme/words.js';

/** What a Quest's main agent is doing right now, in plain words, and since when (the step's stored time). */
export interface Activity {
  text: string;
  since: number;
  /** What kind of step it is, for themed words. */
  kind?: StepKind;
  /** Waiting on the user (an approval or a question). */
  waiting?: boolean;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const MAX = 100;

function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > MAX ? `${line.slice(0, MAX - 1)}…` : line;
}

/** A tool call as a short plain step, e.g. "Editing src/a.ts". Engine-specific, like `buildView`. */
function describeTool(name: string, input: Obj, cwd: string | undefined): string {
  const file = (key: string) => {
    const path = str(input[key]);
    if (!path) return undefined;
    return cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
  };
  switch (name) {
    case 'Bash':
      return clip(str(input.description) ?? str(input.command) ?? 'Running a command');
    case 'Read':
      return clip(`Reading ${file('file_path') ?? 'a file'}`);
    case 'Write':
      return clip(`Writing ${file('file_path') ?? 'a file'}`);
    case 'Edit':
    case 'MultiEdit':
      return clip(`Editing ${file('file_path') ?? 'a file'}`);
    case 'NotebookEdit':
      return clip(`Editing ${file('notebook_path') ?? 'a notebook'}`);
    case 'Grep':
      return clip(`Searching for “${str(input.pattern) ?? '…'}”`);
    case 'Glob':
      return clip(`Looking for files: ${str(input.pattern) ?? '…'}`);
    case 'WebSearch':
      return clip(`Searching the web: ${str(input.query) ?? '…'}`);
    case 'WebFetch':
      return clip(`Reading ${str(input.url) ?? 'a web page'}`);
    case 'Task':
    case 'Agent':
      return clip(`Waiting on a subagent: ${str(input.description) ?? str(input.subagent_type) ?? 'a task'}`);
    case 'AskUserQuestion':
      return 'Asking you a question';
    case 'TodoWrite':
      return 'Updating its plan';
    default:
      // MCP tools are mcp__<server>__<tool>; the tool's own name reads best.
      return clip(`Using ${name.startsWith('mcp__') ? (name.split('__').at(-1) ?? name) : name}`);
  }
}

/** The kind of step a tool call is. Engine-specific, like `describeTool`. */
function toolKind(name: string): StepKind {
  switch (name) {
    case 'Bash':
      return 'run';
    case 'Read':
      return 'read';
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'write';
    case 'Grep':
    case 'Glob':
      return 'search';
    case 'WebSearch':
    case 'WebFetch':
      return 'web';
    case 'Task':
    case 'Agent':
      return 'delegate';
    case 'AskUserQuestion':
      return 'ask';
    case 'TodoWrite':
      return 'plan';
    default:
      return 'tool';
  }
}

/**
 * The current step of the turn in progress, or undefined between turns. Read from the same stored events as the
 * view: the latest of a pending approval, a tool still running, or what the latest line was.
 */
export function currentActivity(envelopes: readonly Envelope[]): Activity | undefined {
  let cwd: string | undefined;
  let activity: Activity | undefined;
  const tools = new Map<string, { text: string; kind: StepKind }>();
  const permissions = new Map<string, string>();

  const latestTool = (since: number): Activity | undefined => {
    const last = [...tools.values()].at(-1);
    return last ? { text: last.text, since, kind: last.kind } : undefined;
  };

  for (const envelope of envelopes) {
    const payload = isObj(envelope.payload) ? envelope.payload : {};
    const at = envelope.ts;
    switch (envelope.type) {
      case 'session.started':
        cwd = str(payload.cwd) ?? cwd;
        continue;
      case 'user.message':
        tools.clear();
        permissions.clear();
        activity = { text: 'Reading your message', since: at, kind: 'listen' };
        continue;
      case 'permission.request': {
        const requestId = str(payload.requestId);
        if (!requestId) continue;
        const input = isObj(payload.input) ? payload.input : {};
        const toolName = str(payload.toolName) ?? 'a tool';
        const step = toolName === 'AskUserQuestion' ? 'Asking you a question' : describeTool(toolName, input, cwd);
        permissions.set(requestId, step);
        activity = {
          text: toolName === 'AskUserQuestion' ? step : `Waiting for your approval: ${step}`,
          since: at,
          waiting: true,
          kind: toolName === 'AskUserQuestion' ? 'ask' : 'wait',
        };
        continue;
      }
      case 'permission.resolved': {
        permissions.delete(str(payload.requestId) ?? '');
        const still = [...permissions.values()].at(-1);
        activity = still
          ? { text: `Waiting for your approval: ${still}`, since: at, waiting: true, kind: 'wait' }
          : (latestTool(at) ?? { text: 'Thinking it over', since: at, kind: 'think' });
        continue;
      }
      case 'turn.finished':
      case 'session.ended':
      case 'session.closed':
        tools.clear();
        permissions.clear();
        activity = undefined;
        continue;
      case 'claude.event':
        break;
      default:
        continue;
    }

    const raw = isObj(payload.raw) ? payload.raw : undefined;
    if (!raw) continue;
    if (raw.type === 'result') {
      tools.clear();
      permissions.clear();
      activity = undefined;
      continue;
    }
    const message = isObj(raw.message) ? raw.message : undefined;
    const content = message && Array.isArray(message.content) ? message.content : [];
    if (raw.type === 'assistant') {
      for (const block of content) {
        if (!isObj(block)) continue;
        if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
          const text = describeTool(block.name, isObj(block.input) ? block.input : {}, cwd);
          const kind = toolKind(block.name);
          tools.set(block.id, { text, kind });
          activity = { text, since: at, kind };
        } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
          activity = { text: 'Thinking', since: at, kind: 'think' };
        } else if (block.type === 'text') {
          activity = { text: 'Writing a reply', since: at, kind: 'reply' };
        }
      }
      continue;
    }
    if (raw.type === 'user') {
      let finished = false;
      for (const block of content) {
        if (isObj(block) && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          finished = tools.delete(block.tool_use_id) || finished;
        }
      }
      if (finished) activity = latestTool(at) ?? { text: 'Thinking it over', since: at, kind: 'think' };
    }
  }
  if (permissions.size > 0 && activity && !activity.waiting) {
    activity = {
      text: `Waiting for your approval: ${[...permissions.values()].at(-1)}`,
      since: activity.since,
      waiting: true,
      kind: 'wait',
    };
  }
  return activity;
}
