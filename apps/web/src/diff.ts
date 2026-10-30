export interface DiffLine {
  kind: 'same' | 'removed' | 'added';
  text: string;
}

/** Lines of a text; a final newline ends the last line rather than starting an empty one. */
const split = (text: string) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));

/**
 * A line diff by longest common subsequence, for tool cards. Past `maxCells` (old lines x new lines) it gives up on
 * alignment and shows everything removed, then everything added, rather than stall the page.
 */
export function diffLines(before: string, after: string, { maxCells = 250_000 } = {}): DiffLine[] {
  const a = split(before);
  const b = split(after);
  if (a.length * b.length > maxCells) {
    return [
      ...a.map((text) => ({ kind: 'removed' as const, text })),
      ...b.map((text) => ({ kind: 'added' as const, text })),
    ];
  }

  // lcs[i][j]: length of the longest common subsequence of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: 'removed', text: a[i++]! });
    } else {
      out.push({ kind: 'added', text: b[j++]! });
    }
  }
  while (i < a.length) out.push({ kind: 'removed', text: a[i++]! });
  while (j < b.length) out.push({ kind: 'added', text: b[j++]! });
  return out;
}
