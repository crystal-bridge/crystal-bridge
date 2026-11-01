import type { Envelope } from '@crystal-bridge/protocol';
import { spokenWords } from './model.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** Characters of context kept on each side of a match. */
const CONTEXT = 60;

/** The readable texts of an event: prompts, replies, tool calls and their output. Plumbing (init lines, ids) is skipped. */
function texts(envelope: Envelope): string[] {
  const p = isObj(envelope.payload) ? envelope.payload : {};
  if (envelope.type === 'session.started') return [str(p.prompt) ?? ''];
  if (envelope.type === 'user.message') return [str(p.text) ?? ''];
  if (envelope.type !== 'claude.event' || !isObj(p.raw) || !isObj(p.raw.message)) return [];
  const content = p.raw.message.content;
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (!isObj(block)) continue;
    const words = spokenWords(block);
    if (words) out.push(words);
    if (block.type === 'tool_use') {
      const input = isObj(block.input) ? block.input : {};
      const what = ['command', 'file_path', 'pattern', 'url', 'description'].map((k) => str(input[k])).find(Boolean);
      out.push(`${str(block.name) ?? 'tool'}: ${what ?? JSON.stringify(input)}`);
    }
    if (block.type === 'tool_result') {
      const c = block.content;
      out.push(
        typeof c === 'string'
          ? c
          : Array.isArray(c)
            ? c.map((b) => (isObj(b) ? (str(b.text) ?? '') : '')).join('\n')
            : '',
      );
    }
  }
  return out;
}

/** The text around the first match of `query` in a search hit's event, or undefined if only its plumbing matched. */
export function snippet(envelope: Envelope, query: string): string | undefined {
  const needle = query.toLowerCase();
  for (const text of texts(envelope)) {
    const flat = text.replace(/\s+/g, ' ').trim();
    const at = flat.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    const start = Math.max(0, at - CONTEXT);
    const end = Math.min(flat.length, at + needle.length + CONTEXT);
    return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
  }
  return undefined;
}
