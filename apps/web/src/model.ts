import type { Envelope } from '@crystal-bridge/protocol';

export type ViewItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: unknown;
      output: string | undefined;
      isError: boolean;
      denied: boolean;
      done: boolean;
    }
  | {
      kind: 'permission';
      id: string;
      requestId: string;
      toolName: string;
      input: unknown;
      pending: boolean;
      behavior: 'allow' | 'deny' | undefined;
    }
  | {
      kind: 'result';
      id: string;
      subtype: string;
      isError: boolean;
      text: string | undefined;
      costUsd: number | undefined;
      durationMs: number | undefined;
    }
  | { kind: 'notice'; id: string; text: string }
  | { kind: 'ended'; id: string; exitCode: number | null; signal: string | null; reason: 'idle' | 'exit' | 'error' }
  | { kind: 'resumed'; id: string }
  | { kind: 'closed'; id: string; worktree: { removed: boolean; reason?: string } | undefined }
  | { kind: 'error'; id: string; message: string };

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/** Tool-result `content` is a string or an array of `{ type: 'text', text }` blocks. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (isObj(block) && typeof block.text === 'string' ? block.text : ''))
      .filter((text) => text !== '')
      .join('\n');
  }
  return '';
}

/**
 * Turns envelopes into view items one at a time. Feed it in seq order with no duplicates; it
 * updates earlier items in place (a tool gets its output, a permission its answer).
 */
export class ViewBuilder {
  readonly items: ViewItem[] = [];
  private readonly tools = new Map<string, Extract<ViewItem, { kind: 'tool' }>>();
  private readonly permissions = new Map<string, Extract<ViewItem, { kind: 'permission' }>>();
  /** Text blocks still streaming, keyed by `${messageId}:${blockIndex}`, in arrival order. */
  private readonly streaming = new Map<string, Extract<ViewItem, { kind: 'assistant' }>>();
  private currentMessageId = '';

  envelope(envelope: Envelope): void {
    const payload = envelope.payload;
    const id = `e${envelope.seq}`;
    switch (envelope.type) {
      case 'session.started': {
        const prompt = isObj(payload) ? str(payload.prompt) : undefined;
        // An adopted session's replayed history carries its first prompt as a user.message already.
        if (prompt && !(isObj(payload) && payload.adopted === true))
          this.items.push({ kind: 'user', id, text: prompt });
        return;
      }
      case 'user.message': {
        const text = isObj(payload) ? str(payload.text) : undefined;
        if (text) this.items.push({ kind: 'user', id, text });
        return;
      }
      case 'claude.event':
        if (isObj(payload)) this.raw(payload.raw, id);
        return;
      case 'permission.request': {
        if (!isObj(payload)) return;
        const requestId = str(payload.requestId);
        if (!requestId) return;
        const item: Extract<ViewItem, { kind: 'permission' }> = {
          kind: 'permission',
          id,
          requestId,
          toolName: str(payload.toolName) ?? 'unknown tool',
          input: payload.input,
          pending: true,
          behavior: undefined,
        };
        this.permissions.set(requestId, item);
        // The CLI streams the tool_use before it asks, so the card goes back in front of its tool.
        const tool = this.tools.get(str(payload.toolUseId) ?? '');
        const at = tool ? this.items.indexOf(tool) : -1;
        if (at >= 0) this.items.splice(at, 0, item);
        else this.items.push(item);
        return;
      }
      case 'permission.resolved': {
        if (!isObj(payload)) return;
        const item = this.permissions.get(str(payload.requestId) ?? '');
        if (!item) return;
        item.pending = false;
        item.behavior = payload.behavior === 'allow' ? 'allow' : 'deny';
        return;
      }
      case 'session.ended': {
        const p = isObj(payload) ? payload : {};
        this.items.push({
          kind: 'ended',
          id,
          exitCode: num(p.exitCode) ?? null,
          signal: str(p.signal) ?? null,
          reason: p.reason === 'idle' || p.reason === 'error' ? p.reason : 'exit',
        });
        return;
      }
      case 'session.resumed':
        this.items.push({ kind: 'resumed', id });
        return;
      case 'session.closed': {
        const w = isObj(payload) && isObj(payload.worktree) ? payload.worktree : undefined;
        const worktree = w
          ? { removed: w.removed === true, ...(typeof w.reason === 'string' ? { reason: w.reason } : {}) }
          : undefined;
        this.items.push({ kind: 'closed', id, worktree });
        return;
      }
      case 'error':
        this.items.push({ kind: 'error', id, message: (isObj(payload) && str(payload.message)) || 'unknown error' });
        return;
    }
  }

  private raw(raw: unknown, id: string): void {
    if (!isObj(raw)) return;
    switch (raw.type) {
      case 'stream_event':
        this.streamEvent(raw, id);
        return;
      case 'assistant':
        this.assistant(raw, id);
        return;
      case 'user':
        this.user(raw, id);
        return;
      case 'result':
        this.items.push({
          kind: 'result',
          id,
          subtype: str(raw.subtype) ?? 'unknown',
          isError: raw.is_error === true,
          text: str(raw.result),
          costUsd: num(raw.total_cost_usd),
          durationMs: num(raw.duration_ms),
        });
        return;
    }
  }

  private streamEvent(raw: Obj, id: string): void {
    const event = raw.event;
    if (!isObj(event)) return;
    const messageId = str(raw.api_message_id) ?? this.currentMessageId;
    const index = num(event.index) ?? 0;

    if (event.type === 'message_start') {
      const message = isObj(event.message) ? event.message : {};
      this.currentMessageId = str(message.id) ?? messageId;
      return;
    }
    if (event.type === 'content_block_start') {
      const block = isObj(event.content_block) ? event.content_block : {};
      if (block.type === 'text') this.streamingText(messageId, index, id);
      if (block.type === 'tool_use') this.tool(str(block.id), str(block.name), undefined, id);
      return;
    }
    if (event.type === 'content_block_delta') {
      const delta = isObj(event.delta) ? event.delta : {};
      if (delta.type === 'text_delta') this.streamingText(messageId, index, id).text += str(delta.text) ?? '';
    }
  }

  private streamingText(messageId: string, index: number, id: string): Extract<ViewItem, { kind: 'assistant' }> {
    const key = `${messageId}:${index}`;
    let item = this.streaming.get(key);
    if (!item) {
      item = { kind: 'assistant', id, text: '', streaming: true };
      this.streaming.set(key, item);
      this.items.push(item);
    }
    return item;
  }

  /** One `assistant` line per content block; several lines can share a message id. */
  private assistant(raw: Obj, id: string): void {
    const message = isObj(raw.message) ? raw.message : {};
    const messageId = str(message.id) ?? '';
    const content = Array.isArray(message.content) ? message.content : [];
    content.forEach((block, i) => {
      if (!isObj(block)) return;
      if (block.type === 'text') {
        const text = str(block.text) ?? '';
        // The earliest still-streaming text block of this message is the one this line completes.
        const entry = [...this.streaming].find(([key]) => key.startsWith(`${messageId}:`));
        if (entry) {
          this.streaming.delete(entry[0]);
          entry[1].text = text;
          entry[1].streaming = false;
        } else if (text !== '') {
          this.items.push({ kind: 'assistant', id: `${id}.${i}`, text, streaming: false });
        }
      } else if (block.type === 'tool_use') {
        this.tool(str(block.id), str(block.name), block.input, `${id}.${i}`);
      }
    });
  }

  private tool(toolUseId: string | undefined, name: string | undefined, input: unknown, id: string): void {
    if (!toolUseId) return;
    const existing = this.tools.get(toolUseId);
    if (existing) {
      if (input !== undefined) existing.input = input;
      if (name) existing.name = name;
      return;
    }
    const item: Extract<ViewItem, { kind: 'tool' }> = {
      kind: 'tool',
      id,
      name: name ?? 'tool',
      input: input ?? {},
      output: undefined,
      isError: false,
      denied: false,
      done: false,
    };
    this.tools.set(toolUseId, item);
    this.items.push(item);
  }

  private user(raw: Obj, id: string): void {
    const message = isObj(raw.message) ? raw.message : {};
    const content = message.content;
    if (typeof content === 'string') {
      if (content !== '') this.items.push({ kind: 'notice', id, text: content });
      return;
    }
    if (!Array.isArray(content)) return;
    const meta = Array.isArray(raw.tool_result_meta) ? raw.tool_result_meta.filter(isObj) : [];
    content.forEach((block, i) => {
      if (!isObj(block)) return;
      if (block.type === 'text') {
        const text = str(block.text);
        if (text) this.items.push({ kind: 'notice', id: `${id}.${i}`, text });
        return;
      }
      if (block.type !== 'tool_result') return;
      const toolUseId = str(block.tool_use_id);
      const tool = toolUseId ? this.tools.get(toolUseId) : undefined;
      if (!tool) return;
      const decision = meta.find((m) => m.id === toolUseId)?.permission_decision;
      tool.output = contentText(block.content);
      tool.isError = block.is_error === true;
      tool.denied = isObj(decision) && decision.decision === 'reject';
      tool.done = true;
    });
  }
}

/**
 * Turns a session's envelopes (in any order, duplicates allowed) into what the session view renders.
 * Pure: the same input always yields an equal output, and nothing in the input is mutated.
 */
export function buildView(envelopes: readonly Envelope[]): ViewItem[] {
  const ordered: Envelope[] = [];
  for (const envelope of envelopes) insertBySeq(ordered, envelope);

  const builder = new ViewBuilder();
  for (const envelope of ordered) builder.envelope(envelope);
  return builder.items;
}

/**
 * Inserts an envelope into a list kept sorted by seq and returns true, or returns false if that
 * seq is already there. Envelopes almost always arrive in order, so the common case is an append.
 */
export function insertBySeq(list: Envelope[], envelope: Envelope): boolean {
  const last = list.at(-1);
  if (!last || envelope.seq > last.seq) {
    list.push(envelope);
    return true;
  }
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.seq < envelope.seq) lo = mid + 1;
    else hi = mid;
  }
  if (list[lo]?.seq === envelope.seq) return false;
  list.splice(lo, 0, envelope);
  return true;
}

/**
 * `buildView` for a list that grows over time, such as a streaming session. Given the same list
 * plus new envelopes at the end, it feeds only the new ones, so a long session doesn't rebuild on
 * every token. Any other change (an envelope inserted earlier, a different session) rebuilds.
 * Expects the list sorted by seq without duplicates, as `insertBySeq` keeps it.
 */
export class IncrementalView {
  private builder = new ViewBuilder();
  private fed: readonly Envelope[] = [];
  private items: ViewItem[] = [];

  update(envelopes: readonly Envelope[]): ViewItem[] {
    const count = this.fed.length;
    const keepsPrefix = count === 0 || envelopes[count - 1] === this.fed[count - 1];
    if (envelopes.length === count && keepsPrefix) return this.items;
    const grows = envelopes.length > count && keepsPrefix;
    if (!grows) this.builder = new ViewBuilder();
    for (let i = grows ? count : 0; i < envelopes.length; i++) this.builder.envelope(envelopes[i]!);
    this.fed = envelopes;
    // A new array so React sees the change. The builder updates its items in place (streaming text, tool results),
    // so each item is handed out as a copy, and the same copy again while its fields are unchanged: a memoised
    // message then skips re-rendering, and only the one that changed (say, the streaming reply) redraws.
    const previous = this.shown;
    this.shown = new Map();
    this.items = this.builder.items.map((item) => {
      const last = previous.get(item);
      const out = last && sameFields(last, item) ? last : { ...item };
      this.shown.set(item, out);
      return out;
    });
    return this.items;
  }

  /** The copy last handed out for each of the builder's items. */
  private shown = new Map<ViewItem, ViewItem>();
}

function sameFields(a: object, b: object): boolean {
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = Object.keys(y);
  return keys.length === Object.keys(x).length && keys.every((key) => x[key] === y[key]);
}

/**
 * The permission mode the CLI last reported (system/init or system/status), if any yet. The CLI calls the mode
 * `--permission-mode manual` starts `default` (checked against 2.1.312), so that's reported as manual.
 */
export function sessionMode(envelopes: readonly Envelope[]): string | undefined {
  for (let i = envelopes.length - 1; i >= 0; i--) {
    const envelope = envelopes[i]!;
    if (envelope.type !== 'claude.event' || !isObj(envelope.payload)) continue;
    const raw = envelope.payload.raw;
    if (isObj(raw) && raw.type === 'system' && typeof raw.permissionMode === 'string')
      return raw.permissionMode === 'default' ? 'manual' : raw.permissionMode;
  }
  return undefined;
}

/** The worktree a session runs in, from its session.started, if it was started in one. */
export function sessionWorktree(envelopes: readonly Envelope[]): { root: string; branch: string } | undefined {
  const started = envelopes.find((e) => e.type === 'session.started');
  const worktree = started && isObj(started.payload) ? started.payload.worktree : undefined;
  return isObj(worktree) && typeof worktree.branch === 'string' && typeof worktree.root === 'string'
    ? { root: worktree.root, branch: worktree.branch }
    : undefined;
}

/** The engine a session runs on, from its session.started; older sessions don't say (the stream engine). */
export function sessionEngine(envelopes: readonly Envelope[]): string | undefined {
  const started = envelopes.find((e) => e.type === 'session.started');
  return started && isObj(started.payload) ? str(started.payload.engine) : undefined;
}

/** The session this one was forked from, if it is a fork. */
export function sessionForkedFrom(envelopes: readonly Envelope[]): string | undefined {
  const started = envelopes.find((e) => e.type === 'session.started');
  return started && isObj(started.payload) ? str(started.payload.forkedFrom) : undefined;
}

/** Slash commands and skills the CLI last reported for the session, minus the ones that only work in a terminal. */
export function slashCommands(envelopes: readonly Envelope[]): string[] {
  for (let i = envelopes.length - 1; i >= 0; i--) {
    const envelope = envelopes[i]!;
    if (envelope.type !== 'claude.event' || !isObj(envelope.payload)) continue;
    const raw = envelope.payload.raw;
    if (!isObj(raw) || raw.type !== 'system' || raw.subtype !== 'init' || !Array.isArray(raw.slash_commands)) continue;
    const terminal = new Set(Array.isArray(raw.terminal_slash_commands) ? raw.terminal_slash_commands : []);
    return raw.slash_commands.filter((c): c is string => typeof c === 'string' && !terminal.has(c)).sort();
  }
  return [];
}
