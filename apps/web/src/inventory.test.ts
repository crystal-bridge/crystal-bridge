import { describe, expect, it } from 'vitest';
import type { Envelope } from '@crystal-bridge/protocol';
import { buildInventory, claudeInventory, filterInventory, type InventorySource } from './inventory.js';

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
  plugins: [
    { name: 'demo-plugin', path: '/p/demo', source: 'demo-plugin@inline', version: '0.0.1' },
    { name: 'cc-plugin-telemetry', path: 'builtin', source: 'cc-plugin-telemetry@builtin' },
  ],
  mcp_servers: [
    { name: 'crystal', status: 'connected', source: 'dynamic' },
    { name: 'github', status: 'connected', source: 'user' },
    { name: 'flaky', status: 'failed', source: 'project' },
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

  it('lists MCP servers and plugins as Equipment with whether they work, leaving out the bridge-s own tool', () => {
    const inv = buildInventory([init]);
    expect(inv.equipment.map((e) => [e.name, e.status])).toEqual([
      ['flaky', 'failed'],
      ['github', 'ok'],
      ['cc-plugin-telemetry', 'ok'],
      ['demo-plugin', 'ok'],
    ]);
    expect(inv.equipment.every((e) => e.use === undefined)).toBe(true);
    expect(inv.equipment.find((e) => e.name === 'cc-plugin-telemetry')!.detail).toMatch(/built in/);
  });

  it('lists the hooks that fired as Abilities, with their latest outcome', () => {
    const inv = buildInventory([init, hook('SessionStart:startup', 'error'), hook('SessionStart:startup', 'success')]);
    expect(inv.abilities).toEqual([
      { category: 'abilities', name: 'SessionStart:startup', detail: 'SessionStart', status: 'ok' },
    ]);
  });

  it('uses the latest init, and is empty before the first one', () => {
    expect(buildInventory([])).toEqual({ spells: [], items: [], equipment: [], abilities: [] });
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
    expect(inv.equipment.map((e) => e.name)).toEqual(['demo-plugin']);
  });
});
