import { describe, expect, it } from 'vitest';
import shipped from '../public/heroes/CREDITS.csv?raw';
import { creditedAuthors, parseCredits, usedUnder } from './credits.js';

const CSV = [
  'filename,notes,authors,licenses,urls',
  'body/a.png,see details,"Ann One,Bob Two","OGA-BY 3.0,CC-BY-SA 3.0","https://x.example/a,https://x.example/b"',
  'hat/b.png,"a ""quoted"" note","Bob Two",CC0,https://x.example/c',
  '',
].join('\n');

describe('parseCredits', () => {
  it('reads each layer, splitting the comma lists inside quoted fields', () => {
    expect(parseCredits(CSV)).toEqual([
      {
        file: 'body/a.png',
        notes: 'see details',
        authors: ['Ann One', 'Bob Two'],
        licences: ['OGA-BY 3.0', 'CC-BY-SA 3.0'],
        urls: ['https://x.example/a', 'https://x.example/b'],
      },
      {
        file: 'hat/b.png',
        notes: 'a "quoted" note',
        authors: ['Bob Two'],
        licences: ['CC0'],
        urls: ['https://x.example/c'],
      },
    ]);
  });
});

describe('creditedAuthors', () => {
  it('lists every author once, sorted', () => {
    expect(creditedAuthors(parseCredits(CSV))).toEqual(['Ann One', 'Bob Two']);
  });
});

describe('usedUnder', () => {
  it('picks the attribution-only licence a layer offers, preferring OGA-BY, then CC-BY, then CC0', () => {
    expect(usedUnder(['CC-BY-SA 3.0', 'GPL 3.0', 'OGA-BY 3.0'])).toBe('OGA-BY 3.0');
    expect(usedUnder(['GPL 3.0', 'CC-BY 4.0'])).toBe('CC-BY 4.0');
    expect(usedUnder(['CC0'])).toBe('CC0');
  });

  it('has none for a share-alike-only layer', () => {
    expect(usedUnder(['CC-BY-SA 3.0', 'GPL 2.0', 'GPL 3.0'])).toBeUndefined();
  });

  it('finds one for every layer of the shipped Hero art, so the pack needs no share-alike', () => {
    const rows = parseCredits(shipped);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((row) => !usedUnder(row.licences)).map((row) => row.file)).toEqual([]);
  });
});
