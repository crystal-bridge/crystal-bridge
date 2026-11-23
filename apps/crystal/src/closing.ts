import { lootPath, lootPaths, trophyLinks } from '@crystal-bridge/protocol';
import type { ReplayEvent } from './transcripts.js';

export const MAX_DIGEST_CHARS = 24_000;
export const MAX_DIGEST_PROMPT = 500;
export const MAX_DIGEST_REPLY = 1500;
const MAX_DIGEST_FILES = 100;
const MAX_TITLE_CHARS = 60;

export interface QuestDigest {
  title: string;
  project: string;
  files: string[];
  moreFiles?: number;
  prs: string[];
  deeds: string[];
  errands: string[];
  turns: { prompt: string; reply: string }[];
  omittedTurns?: number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

// The hub's `errandProject` rule (apps/airship/src/errands.ts): a Quest in a worktree belongs to the repository.
const WORKTREE = /[\\/]\.worktrees[\\/][0-9a-f]{8}[\\/]?$/;

function projectOf(cwd: string): string {
  const root = cwd.replace(WORKTREE, '').replace(/[\\/]+$/, '');
  return root.split(/[\\/]/).pop() ?? '';
}

function replyText(raw: Obj): string {
  const message = raw.message;
  if (!isObj(message) || !Array.isArray(message.content)) return '';
  return message.content
    .map((block) => (isObj(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n');
}

const unique = (list: string[], item: string) => (list.includes(item) ? list : [...list, item]);

/** A Quest's digest for the call at Close (docs/DEEDS.md, Close the chapter), from its transcript's events. */
export function buildDigest(events: readonly ReplayEvent[], quest: { cwd: string }): QuestDigest {
  const turns: { prompt: string; reply: string }[] = [];
  let files: string[] = [];
  let prs: string[] = [];
  let planTitle: string | undefined;
  // Tool calls by id, so a result can say whether its call was refused.
  const pending = new Map<string, { name: string; input: Obj }>();
  const deeds: string[] = [];
  const errands: string[] = [];
  let first: string | undefined;

  for (const event of events) {
    if (event.type === 'user.message') {
      first ??= event.payload.text;
      turns.push({ prompt: event.payload.text.slice(0, MAX_DIGEST_PROMPT), reply: '' });
      continue;
    }
    const raw = event.payload.raw;
    if (!isObj(raw)) continue;
    if (raw.type === 'assistant') {
      for (const path of lootPaths(raw)) files = unique(files, lootPath(path, quest.cwd));
      const message = raw.message;
      if (isObj(message) && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (!isObj(block) || block.type !== 'tool_use') continue;
          if (typeof block.id === 'string' && typeof block.name === 'string') {
            pending.set(block.id, { name: block.name, input: isObj(block.input) ? block.input : {} });
          }
        }
      }
      const text = replyText(raw);
      const turn = turns[turns.length - 1];
      if (turn && text) turn.reply = text.slice(0, MAX_DIGEST_REPLY);
    } else if (raw.type === 'user') {
      for (const link of trophyLinks(raw)) prs = unique(prs, link);
      const message = raw.message;
      if (!isObj(message) || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (!isObj(block) || block.type !== 'tool_result' || block.is_error === true) continue;
        const used = typeof block.tool_use_id === 'string' ? pending.get(block.tool_use_id) : undefined;
        if (!used) continue;
        const { name, input } = used;
        if (name === 'mcp__crystal__title' && planTitle === undefined && typeof input.plain === 'string') {
          planTitle = input.plain;
        } else if (name === 'mcp__crystal__deed' && typeof input.deed === 'string') {
          deeds.push(input.deed);
        } else if (name === 'mcp__crystal__errand' && typeof input.title === 'string') {
          errands.push(input.title);
        }
      }
    }
  }

  const title = planTitle ?? (first ?? '').split('\n')[0]!.slice(0, MAX_TITLE_CHARS);
  return {
    title,
    project: projectOf(quest.cwd),
    files: files.slice(0, MAX_DIGEST_FILES),
    ...(files.length > MAX_DIGEST_FILES ? { moreFiles: files.length - MAX_DIGEST_FILES } : {}),
    prs,
    deeds,
    errands,
    turns,
  };
}

/** The digest as the call reads it: JSON, capped at MAX_DIGEST_CHARS, keeping the first turn and the newest ones. */
export function digestText(digest: QuestDigest): string {
  // `<` is escaped so a reply holding a closing tag can't end the block the digest is wrapped in.
  const encode = (d: QuestDigest) => JSON.stringify(d).replace(/</g, '\\u003c');
  let turns = digest.turns;
  let text = encode(digest);
  while (text.length > MAX_DIGEST_CHARS && turns.length > 1) {
    turns = [turns[0]!, ...turns.slice(2)];
    text = encode({ ...digest, turns, omittedTurns: digest.turns.length - turns.length });
  }
  return text;
}
