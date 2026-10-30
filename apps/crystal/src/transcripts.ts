import { createReadStream, existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ClaudeEventPayload } from './session.js';

/**
 * Reads the CLI's own session transcripts: `<projects>/<cwd with / as ->/<session id>.jsonl`, one JSON object
 * per line. This is the CLI's internal format (checked against 2.1.312), not a documented API, so everything
 * here is defensive: unknown line types are skipped and a file that doesn't parse is ignored.
 */

/** A session the CLI ran on this node, as listed for the hub. */
export interface TranscriptSummary {
  id: string;
  cwd: string;
  /** The first prompt's first line, trimmed. */
  title: string;
  /** The file's last change, epoch ms. */
  updatedAt: number;
  /** Main-thread user and assistant lines. */
  messages: number;
}

/** An event to replay into the hub for an adopted session, as Crystal would have sent it live. */
export type ReplayEvent =
  { type: 'user.message'; payload: { text: string } } | { type: 'claude.event'; payload: ClaudeEventPayload };

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TITLE_CHARS = 80;

async function* jsonLines(file: string): AsyncGenerator<Obj> {
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isObj(parsed)) yield parsed;
    } catch {
      // A torn last line while the CLI is writing, or a format change: skip it.
    }
  }
}

/** Main-thread conversation lines only; subagents run on sidechains. */
function isMain(line: Obj): boolean {
  return (line.type === 'user' || line.type === 'assistant') && line.isSidechain !== true && isObj(line.message);
}

/** A user line's typed text, or undefined for tool results. */
function promptText(message: Obj): string | undefined {
  const { content } = message;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.some((block) => isObj(block) && block.type === 'tool_result'))
    return undefined;
  const text = content
    .filter((block): block is Obj => isObj(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
  return text || undefined;
}

/**
 * Tag-wrapped blocks the CLI adds around commands and context, e.g. <command-name>. Either tag may carry
 * attributes: pastes close with </pasted_content id="...">.
 */
const WRAPPER = /<([a-z][a-z_-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1(?:\s[^>]*)?>/g;
/** Pasted text is the user's own prompt, wrapped: keep what's inside. */
const PASTED = /<pasted_content(?:\s[^>]*)?>([\s\S]*?)<\/pasted_content(?:\s[^>]*)?>/g;

/** A prompt's own words for a title: wrappers removed, pastes unwrapped, first line. Empty when only wrappers. */
function ownWords(text: string): string {
  return (text.replace(PASTED, '$1').replace(WRAPPER, '').trim().split('\n', 1)[0] ?? '').trim();
}

async function summarize(file: string, id: string, updatedAt: number): Promise<TranscriptSummary | undefined> {
  let cwd: string | undefined;
  let title: string | undefined;
  let command: string | undefined;
  let messages = 0;
  for await (const line of jsonLines(file)) {
    if (!isMain(line)) continue;
    messages++;
    if (cwd === undefined && typeof line.cwd === 'string') cwd = line.cwd;
    if (title === undefined && line.type === 'user') {
      const text = promptText(line.message as Obj);
      if (text === undefined) continue;
      const words = ownWords(text);
      if (words) title = words;
      // A session of nothing but slash commands is still worth naming by its first one.
      command ??= /<command-name>([^<]+)<\/command-name>/.exec(text)?.[1]?.trim();
    }
  }
  if (cwd === undefined) return undefined;
  return { id, cwd, title: (title ?? command ?? '').slice(0, TITLE_CHARS) || '(no prompt)', updatedAt, messages };
}

/** Transcript files directly inside each project directory (subagent files live one level deeper). */
async function transcriptFiles(projectsDir: string): Promise<{ id: string; file: string; mtimeMs: number }[]> {
  let projects: string[];
  try {
    projects = await readdir(projectsDir);
  } catch {
    return [];
  }
  const found: { id: string; file: string; mtimeMs: number }[] = [];
  for (const project of projects) {
    let names: string[];
    try {
      names = await readdir(join(projectsDir, project));
    } catch {
      continue;
    }
    for (const name of names) {
      const id = name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : '';
      if (!SESSION_ID.test(id)) continue;
      const file = join(projectsDir, project, name);
      const info = await stat(file).catch(() => undefined);
      if (info?.isFile()) found.push({ id, file, mtimeMs: info.mtimeMs });
    }
  }
  return found;
}

/** Summaries keyed by file, reused while the file's mtime is unchanged. */
const cache = new Map<string, { mtimeMs: number; summary: TranscriptSummary | undefined }>();

/** The `limit` most recently changed sessions, newest first. */
export async function listTranscripts(projectsDir: string, { limit = 50 } = {}): Promise<TranscriptSummary[]> {
  const files = (await transcriptFiles(projectsDir)).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out: TranscriptSummary[] = [];
  for (const { id, file, mtimeMs } of files) {
    if (out.length >= limit) break;
    let entry = cache.get(file);
    if (!entry || entry.mtimeMs !== mtimeMs) {
      entry = { mtimeMs, summary: await summarize(file, id, Math.round(mtimeMs)).catch(() => undefined) };
      cache.set(file, entry);
    }
    // Checked every time, not cached: a session whose folder is gone (e.g. a deleted temp repo) can't resume there.
    if (entry.summary && existsSync(entry.summary.cwd)) out.push(entry.summary);
  }
  return out;
}

/** The transcript file for a session id, if this node has one. */
export async function findTranscript(projectsDir: string, id: string): Promise<string | undefined> {
  if (!SESSION_ID.test(id)) return undefined;
  return (await transcriptFiles(projectsDir)).find((entry) => entry.id === id)?.file;
}

/**
 * A transcript as the events Crystal would have emitted live, for replaying an adopted session into the hub:
 * typed prompts become `user.message`, assistant lines and tool results become `claude.event` with the same
 * `{ type, message }` shape the stream-json output uses.
 */
/**
 * One transcript line as Crystal would have sent it from a live stream-json process, for a session whose engine is
 * the interactive CLI: main-thread assistant lines and tool results pass through in the stream-json shape the
 * client renders. Typed prompts are skipped (Crystal records those as `user.message`), as are sidechains and the
 * transcript's own bookkeeping lines.
 */
/** A line of the main conversation (a prompt, a shell command, a reply or a tool result), not metadata. */
export function isConversationLine(line: unknown): boolean {
  return isObj(line) && isMain(line);
}

export function liveTranscriptEvent(line: unknown): ClaudeEventPayload | undefined {
  if (!isObj(line)) return undefined;
  const finished = taskNotification(line);
  if (finished) return { engine: 'claude', raw: finished };
  if (!isMain(line)) return undefined;
  const message = line.message as Obj;
  if (line.type === 'user' && promptText(message) !== undefined) return undefined;
  const raw: Obj = { type: line.type, message };
  if (isObj(line.toolUseResult) && line.toolUseResult.isAsync === true) raw.tool_use_result = { isAsync: true };
  return { engine: 'claude', raw };
}

const TASK_NOTIFICATION = /^<task-notification>[\s\S]*?<tool-use-id>([^<]+)<[\s\S]*?<status>([^<]+)</;

/**
 * The `system/task_notification` a live stream-json process reports when a background task ends. A transcript has
 * only the text handed to the model: queued as soon as the task ends, then delivered as a user line, or absorbed into
 * a running turn with no user line at all.
 */
function taskNotification(line: Obj): Obj | undefined {
  const queued = line.type === 'queue-operation' && line.operation === 'enqueue';
  const delivered = line.type === 'user' && isObj(line.origin) && line.origin.kind === 'task-notification';
  const text = queued ? line.content : delivered && isObj(line.message) ? line.message.content : undefined;
  const match = typeof text === 'string' ? TASK_NOTIFICATION.exec(text) : null;
  if (!match) return undefined;
  return { type: 'system', subtype: 'task_notification', tool_use_id: match[1], status: match[2] };
}

/**
 * What an interactive session has to work with, gathered from the listing lines its transcript records: skills
 * (`attachment.type: skill_listing`, `names`) and tools as they become available (`deferred_tools_delta`:
 * `addedNames`/`removedNames`, `pendingMcpServers`, `failedMcpServers`). Internal format, checked against 2.1.312.
 * A headless session reports the same through `system/init`, which an interactive one never writes.
 */
export interface SessionListing {
  skills: string[];
  tools: Set<string>;
  pending: string[];
  failed: string[];
}

export function emptyListing(): SessionListing {
  return { skills: [], tools: new Set(), pending: [], failed: [] };
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/** Folds one transcript line into the listing; true when it changed anything. */
export function applyListing(listing: SessionListing, line: unknown): boolean {
  if (!isObj(line) || line.type !== 'attachment' || !isObj(line.attachment)) return false;
  const attachment = line.attachment;
  if (attachment.type === 'skill_listing') {
    // An initial listing names every skill; a later one only adds.
    const names = strings(attachment.names);
    listing.skills = attachment.isInitial === false ? [...new Set([...listing.skills, ...names])] : names;
    return true;
  }
  if (attachment.type === 'deferred_tools_delta') {
    for (const name of strings(attachment.addedNames)) listing.tools.add(name);
    for (const name of strings(attachment.removedNames)) listing.tools.delete(name);
    listing.pending = strings(attachment.pendingMcpServers);
    listing.failed = strings(attachment.failedMcpServers);
    return true;
  }
  return false;
}

/** A server name as the CLI shows it: its claude.ai connectors' tool prefix `claude_ai_Gmail` is "claude.ai Gmail". */
function serverName(prefix: string): string {
  return prefix.startsWith('claude_ai_') ? `claude.ai ${prefix.slice('claude_ai_'.length).replace(/_/g, ' ')}` : prefix;
}

/** The listing in `system/init`'s field shapes, which the client's Inventory reads. */
export function listingFields(listing: SessionListing): {
  skills: string[];
  slash_commands: string[];
  mcp_servers: { name: string; status: string }[];
} {
  const tools = new Map<string, string[]>();
  for (const tool of listing.tools) {
    const match = /^mcp__(.+?)__(.+)$/.exec(tool);
    if (match) tools.set(serverName(match[1]!), [...(tools.get(serverName(match[1]!)) ?? []), match[2]!]);
  }
  const status = new Map<string, string>();
  for (const [server, names] of tools) {
    // A server waiting on sign-in offers nothing but its sign-in tools.
    const signInOnly = names.every((name) => name === 'authenticate' || name === 'complete_authentication');
    status.set(server, signInOnly ? 'needs-auth' : 'connected');
  }
  for (const name of listing.pending) status.set(serverName(name), 'pending');
  for (const name of listing.failed) status.set(serverName(name), 'failed');
  const mcp_servers = [...status]
    .map(([name, state]) => ({ name, status: state }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // Skills are typed as slash commands too; other commands aren't listed anywhere a session can read for free.
  return { skills: listing.skills, slash_commands: listing.skills, mcp_servers };
}

export async function transcriptEvents(file: string): Promise<ReplayEvent[]> {
  const events: ReplayEvent[] = [];
  for await (const line of jsonLines(file)) {
    if (!isMain(line)) continue;
    const message = line.message as Obj;
    const text = line.type === 'user' ? promptText(message) : undefined;
    if (text !== undefined) {
      events.push({ type: 'user.message', payload: { text } });
    } else {
      events.push({ type: 'claude.event', payload: { engine: 'claude', raw: { type: line.type, message } } });
    }
  }
  return events;
}
