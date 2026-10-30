import type { Envelope } from '@crystal-bridge/protocol';

/**
 * The Inventory: what a Quest's engine can use, grouped by how it behaves (docs/THEME.md). Spells and Items are used
 * by inserting them into the prompt; Equipment is always on and shows whether it works; Abilities fire by themselves.
 */
export type InventoryCategory = 'spells' | 'items' | 'equipment' | 'abilities';

export interface InventoryEntry {
  /** One of InventoryCategory; any other kind a source reports lands in Items. */
  category: string;
  name: string;
  /** Text to put in the prompt when used; absent for things you can't use by hand. */
  use?: string;
  /** A short note: a version, where it comes from, the event a hook runs on. */
  detail?: string;
  status?: 'ok' | 'failed' | 'pending' | 'unknown';
}

export type Inventory = Record<InventoryCategory, InventoryEntry[]>;

/** Reads one engine's events into entries. Another engine adds its own source; the panel doesn't change. */
export type InventorySource = (envelopes: readonly Envelope[]) => InventoryEntry[];

const CATEGORIES: readonly InventoryCategory[] = ['spells', 'items', 'equipment', 'abilities'];

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function claudeRaw(envelope: Envelope): Record<string, unknown> | undefined {
  if (envelope.type !== 'claude.event' || !isObj(envelope.payload)) return undefined;
  const raw = envelope.payload.raw;
  return isObj(raw) && raw.type === 'system' ? raw : undefined;
}

function serverStatus(status: unknown): InventoryEntry['status'] {
  if (status === 'connected') return 'ok';
  if (status === 'failed') return 'failed';
  if (status === 'pending') return 'pending';
  return 'unknown';
}

/** The bridge's own permission tool, which every Quest has; it's plumbing, not equipment. */
const BRIDGE_SERVER = 'crystal';

/**
 * Claude Code's inventory, from the latest `system/init` (skills, slash commands, MCP servers, plugins) and the
 * `system/hook_response` events of hooks that have run. Field shapes are recorded in apps/crystal/test/fixtures.
 */
export const claudeInventory: InventorySource = (envelopes) => {
  let init: Record<string, unknown> | undefined;
  const hooks = new Map<string, InventoryEntry>();
  for (const envelope of envelopes) {
    const raw = claudeRaw(envelope);
    if (!raw) continue;
    if (raw.subtype === 'init') init = raw;
    if (raw.subtype === 'hook_response' && typeof raw.hook_name === 'string') {
      hooks.set(raw.hook_name, {
        category: 'abilities',
        name: raw.hook_name,
        ...(typeof raw.hook_event === 'string' ? { detail: raw.hook_event } : {}),
        status: raw.outcome === 'success' ? 'ok' : 'failed',
      });
    }
  }
  const entries: InventoryEntry[] = [];
  if (init) {
    const skills = new Set(strings(init.skills));
    const terminal = new Set(strings(init.terminal_slash_commands));
    for (const name of [...skills].sort()) entries.push({ category: 'spells', name, use: `/${name} ` });
    for (const name of strings(init.slash_commands).sort()) {
      if (!skills.has(name) && !terminal.has(name)) entries.push({ category: 'items', name, use: `/${name} ` });
    }
    const servers = (Array.isArray(init.mcp_servers) ? init.mcp_servers : []).filter(isObj);
    for (const server of servers.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
      if (typeof server.name !== 'string' || (server.name === BRIDGE_SERVER && server.source === 'dynamic')) continue;
      entries.push({
        category: 'equipment',
        name: server.name,
        detail: `MCP server${typeof server.source === 'string' ? ` · ${server.source}` : ''}`,
        status: serverStatus(server.status),
      });
    }
    const plugins = (Array.isArray(init.plugins) ? init.plugins : []).filter(isObj);
    for (const plugin of plugins.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
      if (typeof plugin.name !== 'string') continue;
      const version = typeof plugin.version === 'string' ? ` ${plugin.version}` : '';
      entries.push({
        category: 'equipment',
        name: plugin.name,
        detail: plugin.path === 'builtin' ? 'plugin · built in' : `plugin${version}`,
        status: 'ok',
      });
    }
  }
  return [...entries, ...hooks.values()];
};

/** Every source's entries, grouped by category; unknown categories go to Items. */
export function buildInventory(
  envelopes: readonly Envelope[],
  sources: readonly InventorySource[] = [claudeInventory],
): Inventory {
  const inventory: Inventory = { spells: [], items: [], equipment: [], abilities: [] };
  for (const source of sources) {
    for (const entry of source(envelopes)) {
      const category = (CATEGORIES as readonly string[]).includes(entry.category)
        ? (entry.category as InventoryCategory)
        : 'items';
      inventory[category].push(entry);
    }
  }
  return inventory;
}

/** Only the entries whose name contains `query`, ignoring case. */
export function filterInventory(inventory: Inventory, query: string): Inventory {
  const q = query.trim().toLowerCase();
  if (!q) return inventory;
  const keep = (entries: InventoryEntry[]) => entries.filter((entry) => entry.name.toLowerCase().includes(q));
  return {
    spells: keep(inventory.spells),
    items: keep(inventory.items),
    equipment: keep(inventory.equipment),
    abilities: keep(inventory.abilities),
  };
}
