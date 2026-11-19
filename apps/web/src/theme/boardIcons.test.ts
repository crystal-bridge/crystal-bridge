import { describe, expect, it } from 'vitest';
import { ScoutManifest } from '@crystal-bridge/protocol';
import { BOARD_ICONS, boardIcon } from './boardIcons.js';

describe('Board icons', () => {
  it("names each one as scout.json's `icon` may", () => {
    const base = ScoutManifest.parse({
      name: 'x',
      schedule: { cron: '* * * * *', timezone: 'UTC' },
      collect: { command: ['x'] },
      view: 'list',
      actions: {},
    });
    for (const name of Object.keys(BOARD_ICONS)) {
      expect(ScoutManifest.safeParse({ ...base, icon: name }).success, name).toBe(true);
    }
  });

  it('draws a known name, and nothing for an unknown one or a prototype key', () => {
    expect(boardIcon('mail')).toBe('boardMail');
    expect(boardIcon('telescope')).toBeUndefined();
    expect(boardIcon('constructor')).toBeUndefined();
    expect(boardIcon(undefined)).toBeUndefined();
  });
});
