import type { Envelope } from '@crystal-bridge/protocol';
import { sessionMode } from './model.js';

/** A file the session wrote, for the side panel's Outputs. */
export interface OutputFile {
  path: string;
  /** Relative to the session's folder when inside it. */
  display: string;
  kind: 'created' | 'edited';
  changes: number;
}

/** A subagent, background command or Monitor the session started. */
export interface SessionTask {
  id: string;
  kind: 'agent' | 'background' | 'monitor';
  description: string;
  running: boolean;
  /** A subagent's type as the engine names it (e.g. Explore), for picking its Hero's Class. */
  agentType?: string;
}

/** A session's totals across every turn and process, from each turn's `result`. */
export interface SessionStats {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Finished turns, including interrupted and failed ones. */
  turns: number;
  /** Time spent working on turns, summed. */
  workingMs: number;
}

/** What the side panel shows about a session, derived from its stored events. */
export interface SessionInfo {
  cwd?: string;
  /** The effort the session started with, when it picked one (#32). */
  effort?: string;
  branch?: string;
  model?: string;
  mode?: string;
  /** Tokens in the latest request, and the model's window when the CLI has reported it. */
  context?: { used: number; window?: number };
  costUsd: number;
  stats: SessionStats;
  outputs: OutputFile[];
  tasks: SessionTask[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown) => (typeof v === 'number' ? v : 0);

const WRITE_TOOLS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};
const AGENT_TOOLS = new Set(['Task', 'Agent']);

/**
 * A turn's own cost from the CLI's running `total_cost_usd`, which carries across resumes. A line without one (a
 * stopped interactive turn) leaves the count alone; a lower one means a new count began, so all of it is new.
 */
export function costStep(total: unknown, running: number): { cost: number; running: number } {
  if (typeof total !== 'number') return { cost: 0, running };
  return { cost: total >= running ? total - running : total, running: total };
}

/** Engine-specific reading of the CLI's stream-json, like `buildView`: unknown lines are ignored. */
export function sessionInfo(envelopes: readonly Envelope[]): SessionInfo {
  const info: SessionInfo = {
    costUsd: 0,
    stats: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, turns: 0, workingMs: 0 },
    outputs: [],
    tasks: [],
  };
  const outputs = new Map<string, OutputFile>();
  const tasks = new Map<string, SessionTask>();
  let runningCost = 0;
  let windows: Record<string, number> = {};

  for (const envelope of envelopes) {
    const payload = isObj(envelope.payload) ? envelope.payload : {};
    if (envelope.type === 'session.started') {
      if (typeof payload.cwd === 'string') info.cwd = payload.cwd;
      if (typeof payload.effort === 'string') info.effort = payload.effort;
      if (isObj(payload.worktree) && typeof payload.worktree.branch === 'string') info.branch = payload.worktree.branch;
      continue;
    }
    if (envelope.type === 'session.ended') {
      for (const task of tasks.values()) task.running = false;
      continue;
    }
    if (envelope.type !== 'claude.event' || !isObj(payload.raw)) continue;
    const raw = payload.raw;

    if (raw.type === 'system' && raw.subtype === 'init' && typeof raw.model === 'string') info.model = raw.model;
    if (raw.type === 'system' && raw.subtype === 'context_window' && typeof raw.contextWindow === 'number') {
      windows = { session: raw.contextWindow };
    }
    if (raw.type === 'result') {
      const step = costStep(raw.total_cost_usd, runningCost);
      info.costUsd += step.cost;
      runningCost = step.running;
      // Unlike total_cost_usd, a result's usage and duration cover that turn alone, so they simply add up.
      const { stats } = info;
      stats.turns += 1;
      stats.workingMs += num(raw.duration_ms);
      if (isObj(raw.usage)) {
        stats.tokens.input += num(raw.usage.input_tokens);
        stats.tokens.output += num(raw.usage.output_tokens);
        stats.tokens.cacheRead += num(raw.usage.cache_read_input_tokens);
        stats.tokens.cacheWrite += num(raw.usage.cache_creation_input_tokens);
      }
      if (isObj(raw.modelUsage)) {
        windows = {};
        for (const [model, usage] of Object.entries(raw.modelUsage)) {
          if (isObj(usage) && typeof usage.contextWindow === 'number') windows[model] = usage.contextWindow;
        }
      }
    }

    const message = isObj(raw.message) ? raw.message : undefined;
    if (raw.type === 'assistant' && message) {
      if (isObj(message.usage)) {
        const u = message.usage;
        info.context = {
          used: num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens),
        };
      }
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (
          !isObj(block) ||
          block.type !== 'tool_use' ||
          typeof block.name !== 'string' ||
          typeof block.id !== 'string'
        )
          continue;
        const input = isObj(block.input) ? block.input : {};
        const pathKey = WRITE_TOOLS[block.name];
        const path = pathKey ? input[pathKey] : undefined;
        if (typeof path === 'string') {
          const existing = outputs.get(path);
          outputs.delete(path); // re-inserted last: most recent first below
          outputs.set(path, {
            path,
            display: info.cwd && path.startsWith(`${info.cwd}/`) ? path.slice(info.cwd.length + 1) : path,
            kind: existing?.kind ?? (block.name === 'Write' ? 'created' : 'edited'),
            changes: (existing?.changes ?? 0) + 1,
          });
        }
        const description =
          typeof input.description === 'string' ? input.description : String(input.command ?? block.name);
        if (AGENT_TOOLS.has(block.name)) {
          const task: SessionTask = { id: block.id, kind: 'agent', description, running: true };
          if (typeof input.subagent_type === 'string') task.agentType = input.subagent_type;
          tasks.set(block.id, task);
        }
        if (block.name === 'Bash' && input.run_in_background === true) {
          tasks.set(block.id, { id: block.id, kind: 'background', description, running: true });
        }
        if (block.name === 'Monitor')
          tasks.set(block.id, { id: block.id, kind: 'monitor', description, running: true });
      }
    }
    // A subagent is done when its result comes back; a background command's first result only means it started.
    if (raw.type === 'user' && message && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isObj(block) && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const task = tasks.get(block.tool_use_id);
          if (task?.kind === 'agent') task.running = false;
        }
      }
    }
  }

  if (info.context) {
    const window = (info.model && windows[info.model]) || Object.values(windows)[0];
    if (window) info.context.window = window;
  }
  const mode = sessionMode(envelopes);
  if (mode) info.mode = mode;
  info.outputs = [...outputs.values()].reverse();
  info.tasks = [...tasks.values()];
  return info;
}
