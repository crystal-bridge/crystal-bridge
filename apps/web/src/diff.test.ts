import { describe, expect, it } from 'vitest';
import { diffLines } from './diff.js';

describe('diffLines', () => {
  it('keeps shared lines and marks removed and added ones, in order', () => {
    expect(diffLines('a\nb\nc', 'a\nB\nc\nd')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'B' },
      { kind: 'same', text: 'c' },
      { kind: 'added', text: 'd' },
    ]);
  });

  it('treats an empty side as all added or all removed', () => {
    expect(diffLines('', 'x\ny')).toEqual([
      { kind: 'added', text: 'x' },
      { kind: 'added', text: 'y' },
    ]);
    expect(diffLines('x', '')).toEqual([{ kind: 'removed', text: 'x' }]);
  });

  it('falls back to removed-then-added past the size limit instead of a slow diff', () => {
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n');
    const lines = diffLines(big, `${big}\nmore`, { maxCells: 1000 });
    expect(lines.filter((l) => l.kind === 'removed')).toHaveLength(3000);
    expect(lines.filter((l) => l.kind === 'added')).toHaveLength(3001);
  });

  it('does not count the empty line after a final newline', () => {
    expect(diffLines('', '# Plan\n- one\n')).toEqual([
      { kind: 'added', text: '# Plan' },
      { kind: 'added', text: '- one' },
    ]);
  });
});
