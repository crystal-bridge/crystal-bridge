import { describe, expect, it } from 'vitest';
import type { Envelope } from '@crystal-bridge/protocol';
import {
  buildInventory,
  claudeInventory,
  emptyInventory,
  filterInventory,
  grantsOf,
  type InventorySource,
} from './inventory.js';

let seq = 0;
function claude(raw: Record<string, unknown>): Envelope {
  return {
    node: 'n',
    session: '11111111-1111-4111-8111-111111111111',
    seq: seq++,
    ts: 0,
    type: 'claude.event',
    payload: { engine: 'claude', raw },
  };
}

// Shapes as CLI 2.1.312 reports them (see apps/crystal/test/fixtures/README.md).
const init = claude({
  type: 'system',
  subtype: 'init',
  slash_commands: ['demo-skill', 'demo-plugin:demo-cmd', 'compact', 'doctor', 'review-pr'],
  terminal_slash_commands: ['doctor'],
  skills: ['demo-skill'],
  agents: ['claude', 'code-reviewer', 'Explore'],
  tools: ['Bash', 'Read', 'mcp__github__get_issue', 'mcp__github__list_prs', 'mcp__claude_ai_Gmail__search'],
  plugins: [
    { name: 'demo-plugin', path: '/p/demo', source: 'demo-plugin@inline', version: '0.0.1' },
    { name: 'cc-plugin-telemetry', path: 'builtin', source: 'cc-plugin-telemetry@builtin' },
  ],
  mcp_servers: [
    { name: 'crystal', status: 'connected', source: 'dynamic' },
    { name: 'github', status: 'connected', source: 'user' },
    { name: 'flaky', status: 'failed', source: 'project' },
    { name: 'claude.ai Gmail', status: 'connected', source: 'claudeai' },
    { name: 'sentry', status: 'needs-auth', source: 'user' },
  ],
});
const hook = (name: string, outcome: string) =>
  claude({ type: 'system', subtype: 'hook_response', hook_name: name, hook_event: name.split(':')[0], outcome });

describe('claudeInventory', () => {
  it('sorts skills into Spells and the other slash commands into Items, minus terminal-only ones', () => {
    const inv = buildInventory([init]);
    expect(inv.spells.map((e) => e.name)).toEqual(['demo-skill']);
    expect(inv.items.map((e) => e.name)).toEqual(['compact', 'demo-plugin:demo-cmd', 'review-pr']);
    expect(inv.spells[0]!.use).toBe('/demo-skill ');
  });

  it('lists MCP servers as Runes with whether they work, leaving out the bridge-s own tool', () => {
    const inv = buildInventory([init]);
    expect(inv.runes.map((e) => [e.name, e.status])).toEqual([
      ['claude.ai Gmail', 'ok'],
      ['flaky', 'failed'],
      ['github', 'ok'],
      ['sentry', 'needs-auth'],
    ]);
  });

  it('counts each server-s tools, matching a connector-s tool prefix to its name', () => {
    const inv = buildInventory([init]);
    const detail = (name: string) => inv.runes.find((e) => e.name === name)!.detail;
    expect(detail('github')).toBe('2 tools · user');
    expect(detail('claude.ai Gmail')).toBe('1 tool · claudeai');
    expect(detail('flaky')).toBe('MCP server · project');
  });

  it('gives Runes and agents a plain sentence to use, so it works on any engine', () => {
    const inv = buildInventory([init]);
    expect(inv.runes.find((e) => e.name === 'github')!.use).toBe('Use the github tools to ');
    expect(inv.guild.find((e) => e.name === 'Explore')!.use).toBe('Use the Explore agent to ');
  });

  it('lists plugins as Equipment, which have nothing to use or watch', () => {
    const inv = buildInventory([init]);
    expect(inv.gear.map((e) => e.name)).toEqual(['cc-plugin-telemetry', 'demo-plugin']);
    expect(inv.gear.every((e) => e.use === undefined && e.status === undefined)).toBe(true);
    expect(inv.gear.find((e) => e.name === 'cc-plugin-telemetry')!.detail).toMatch(/built in/);
    expect(inv.gear.find((e) => e.name === 'demo-plugin')!.detail).toBe('plugin 0.0.1');
  });

  it('lists agents as the Guild, without the main agent itself', () => {
    expect(buildInventory([init]).guild.map((e) => e.name)).toEqual(['code-reviewer', 'Explore']);
  });

  it('lists the hooks that fired as Abilities, with their latest outcome', () => {
    const inv = buildInventory([init, hook('SessionStart:startup', 'error'), hook('SessionStart:startup', 'success')]);
    expect(inv.abilities).toEqual([
      { category: 'abilities', name: 'SessionStart:startup', detail: 'SessionStart', status: 'ok' },
    ]);
  });

  it('uses the latest init, and is empty before the first one', () => {
    expect(buildInventory([])).toEqual(emptyInventory());
    const later = claude({ type: 'system', subtype: 'init', slash_commands: ['clear'], skills: [] });
    expect(buildInventory([init, later]).items.map((e) => e.name)).toEqual(['clear']);
  });

  it('is one source among any: another engine-s entries merge in, and unknown kinds land in Items', () => {
    const other: InventorySource = () => [{ category: 'scrolls', name: 'ancient', use: '/ancient ' }];
    const inv = buildInventory([init], [claudeInventory, other]);
    expect(inv.items.map((e) => e.name)).toContain('ancient');
  });
});

describe('filterInventory', () => {
  it('keeps entries whose name contains the query, ignoring case', () => {
    const inv = filterInventory(buildInventory([init]), 'DEMO');
    expect(inv.spells.map((e) => e.name)).toEqual(['demo-skill']);
    expect(inv.items.map((e) => e.name)).toEqual(['demo-plugin:demo-cmd']);
    expect(inv.gear.map((e) => e.name)).toEqual(['demo-plugin']);
  });
});

describe('grantsOf', () => {
  it('counts the Spells and Items a plugin brings, by their name prefix', () => {
    const inv = buildInventory([
      claude({
        type: 'system',
        subtype: 'init',
        skills: ['forge:one', 'forge:two', 'solo'],
        slash_commands: ['forge:one', 'forge:two', 'solo', 'forge:cmd', 'forger:other'],
      }),
    ]);
    expect(grantsOf(inv, 'forge')).toEqual({ spells: 2, items: 1 });
    expect(grantsOf(inv, 'nothing')).toEqual({ spells: 0, items: 0 });
  });
});
