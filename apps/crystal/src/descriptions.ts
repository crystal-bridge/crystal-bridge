import { open, readdir, realpath } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import type { ClaudeEventPayload } from './session.js';

/**
 * Descriptions for the Inventory's tooltips. `system/init` carries names alone, so the Kingdom reads the `description`
 * in the frontmatter of the files that define each skill, command and agent. These layouts are the CLI's and may move:
 * a missing folder or an unreadable file just means no tooltip. Nothing else under the config folder is read.
 */
const MAX_DESCRIPTION = 300;
/** Files read per scan, so a huge plugin folder can't stall a start. */
const MAX_FILES = 300;
/** Frontmatter lives at the top of a file; nothing past this is ever read. */
const HEAD_BYTES = 16 * 1024;

export interface DescriptionSources {
  /** CLAUDE_CONFIG_DIR, else `~/.claude`. */
  configDir: string;
  cwd: string;
  /** Plugins with a folder on disk. */
  plugins: { name: string; path: string }[];
}

/** One line of YAML's scalars, as these files use them: bare, or in single or double quotes. */
function scalar(text: string): string {
  const value = text.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

/** The `name` and `description` of a Markdown file's frontmatter. Only these keys, so this isn't a YAML parser. */
export function frontmatter(text: string): { name?: string; description?: string } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {};
  const found: { name?: string; description?: string } = {};
  for (let i = 1; i < lines.length && lines[i]!.trim() !== '---'; i += 1) {
    const key = /^(name|description):\s*(.*)$/.exec(lines[i]!);
    if (!key) continue;
    const field = key[1] as 'name' | 'description';
    const first = key[2]!;
    const parts = /^[|>][-+]?\s*$/.test(first) ? [] : [first];
    // A block, or a plain value wrapped onto indented lines; blank lines inside one are part of it.
    while (i + 1 < lines.length && /^(\s+\S|\s*$)/.test(lines[i + 1]!)) {
      i += 1;
      parts.push(lines[i]!);
    }
    const value = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (value) found[field] = scalar(value);
  }
  return found;
}

/** A folder's entries, or none if it's missing or unreadable. */
async function names(folder: string): Promise<string[]> {
  try {
    return await readdir(folder);
  } catch {
    return [];
  }
}

/** A file's frontmatter, if it sits inside `root` once links are followed. */
async function readInside(root: string, path: string): Promise<ReturnType<typeof frontmatter>> {
  try {
    const [top, real] = await Promise.all([realpath(root), realpath(path)]);
    if (!real.startsWith(`${top}${sep}`)) return {};
    const file = await open(real, 'r');
    try {
      const { buffer, bytesRead } = await file.read(Buffer.alloc(HEAD_BYTES), 0, HEAD_BYTES, 0);
      return frontmatter(buffer.toString('utf8', 0, bytesRead));
    } finally {
      await file.close();
    }
  } catch {
    return {};
  }
}

const capped = (text: string) =>
  text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…` : text;

/** Reads each folder's skills, commands and agents, earlier folders winning a shared name. */
export async function readDescriptions(
  { configDir, cwd, plugins }: DescriptionSources,
  maxFiles = MAX_FILES,
): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  let left = maxFiles;
  const take = async (root: string, path: string, fallback: string, prefix: string) => {
    if (left <= 0) return;
    left -= 1;
    const { name, description } = await readInside(root, path);
    const key = `${prefix}${name ?? fallback}`;
    if (description && !(key in found)) found[key] = capped(description);
  };
  const scanSkills = async (skills: string, prefix: string) => {
    for (const skill of await names(skills)) await take(skills, join(skills, skill, 'SKILL.md'), skill, prefix);
  };
  const scan = async (base: string, prefix: string) => {
    await scanSkills(join(base, 'skills'), prefix);
    for (const kind of ['commands', 'agents']) {
      const folder = join(base, kind);
      for (const file of await names(folder)) {
        if (file.endsWith('.md')) await take(folder, join(folder, file), basename(file, '.md'), prefix);
      }
    }
  };
  await scan(join(cwd, '.claude'), '');
  await scan(configDir, '');
  // Skills synced from the account sit one folder deeper, per account.
  const synced = join(configDir, 'skills', 'synced');
  for (const account of await names(synced)) await scanSkills(join(synced, account), '');
  for (const plugin of plugins) await scan(plugin.path, `${plugin.name}:`);
  return found;
}

const isObj = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

export type DescriptionReporter = (init: unknown, emit: (payload: ClaudeEventPayload) => void) => void;

/**
 * Sends a Quest's descriptions as `system/descriptions`, a line of its own after `system/init`. Every turn repeats the
 * init, so it reads again only when the list changes, and it never holds a turn up. Only what the Quest lists goes out.
 */
export function descriptionReporter({
  configDir,
  cwd,
}: Pick<DescriptionSources, 'configDir' | 'cwd'>): DescriptionReporter {
  let list: string | undefined;
  let sent = '{}';
  let latest = 0;
  return (init, emit) => {
    if (!isObj(init)) return;
    const listed = new Set([...strings(init.skills), ...strings(init.slash_commands), ...strings(init.agents)]);
    const plugins = (Array.isArray(init.plugins) ? init.plugins : []).flatMap((plugin: unknown) =>
      isObj(plugin) && typeof plugin.name === 'string' && typeof plugin.path === 'string' && plugin.path !== 'builtin'
        ? [{ name: plugin.name, path: plugin.path }]
        : [],
    );
    const key = JSON.stringify([[...listed].sort(), plugins]);
    if (key === list) return;
    list = key;
    latest += 1;
    const scan = latest;
    void readDescriptions({ configDir, cwd, plugins }).then((found) => {
      if (scan !== latest) return; // The list moved on while this one was being read.
      const descriptions = Object.fromEntries(Object.entries(found).filter(([name]) => listed.has(name)));
      const text = JSON.stringify(descriptions);
      if (text === sent) return;
      sent = text;
      emit({ engine: 'claude', raw: { type: 'system', subtype: 'descriptions', descriptions } });
    });
  };
}
