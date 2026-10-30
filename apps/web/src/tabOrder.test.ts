import { describe, expect, it } from 'vitest';
import { applyOrder, moveTo } from './tabOrder.js';

const ids = (items: { id: string }[]) => items.map((item) => item.id);
const items = ['a', 'b', 'c', 'd'].map((id) => ({ id }));

describe('applyOrder', () => {
  it('puts saved ids first, in saved order, and appends new ones in their default order', () => {
    expect(ids(applyOrder(items, ['c', 'a']))).toEqual(['c', 'a', 'b', 'd']);
  });

  it('ignores saved ids that are no longer there, and keeps the default with no saved order', () => {
    expect(ids(applyOrder(items, ['gone', 'b']))).toEqual(['b', 'a', 'c', 'd']);
    expect(ids(applyOrder(items, undefined))).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('moveTo', () => {
  it('moves an id to a position among the ids shown now, keeping the rest in order', () => {
    expect(moveTo(['a', 'b', 'c', 'd'], 'a', 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveTo(['a', 'b', 'c', 'd'], 'd', 0)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('clamps the position and leaves an unknown id alone', () => {
    expect(moveTo(['a', 'b'], 'a', 9)).toEqual(['b', 'a']);
    expect(moveTo(['a', 'b'], 'b', -3)).toEqual(['b', 'a']);
    expect(moveTo(['a', 'b'], 'x', 0)).toEqual(['a', 'b']);
  });
});
