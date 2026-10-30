import { describe, expect, it } from 'vitest';
import { COMPANIONS, companionFor } from './companions.js';

describe('companions', () => {
  it('draws each one as a 16x16 grid whose letters are all in its palette', () => {
    for (const [id, companion] of Object.entries(COMPANIONS)) {
      expect(companion.rows, id).toHaveLength(16);
      for (const row of companion.rows) {
        expect(row, id).toHaveLength(16);
        for (const ch of row.replaceAll('.', '')) expect(companion.palette, `${id} ${ch}`).toHaveProperty(ch);
      }
    }
  });

  it('sends the Owl to keep watch on a Monitor', () => {
    expect(companionFor({ id: 'm1', kind: 'monitor' })).toBe('owl');
  });

  it('gives a background command one of the others, the same one every time', () => {
    const picks = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8'].map((id) =>
      companionFor({ id, kind: 'background' }),
    );
    expect(new Set(picks).size).toBeGreaterThan(1);
    expect(picks).not.toContain('owl');
    expect(companionFor({ id: 'b1', kind: 'background' })).toBe(picks[0]);
  });
});
