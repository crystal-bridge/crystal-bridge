/**
 * The Hero art's credits (`public/heroes/CREDITS.csv`, one row per sprite layer), read for the in-app Credits: the art
 * licences ask for credit that can be found from within the app, not only in the repo.
 */
export interface CreditRow {
  file: string;
  notes: string;
  authors: string[];
  licences: string[];
  urls: string[];
}

/** Splits CSV text into rows of fields: commas separate, double quotes wrap, and "" inside quotes is a quote. */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

const list = (field: string | undefined) =>
  (field ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

/** The credit rows, from the CSV with its header row (filename, notes, authors, licenses, urls). */
export function parseCredits(text: string): CreditRow[] {
  const [header, ...rows] = csvRows(text);
  if (!header) return [];
  const at = (name: string) => header.indexOf(name);
  return rows.map((r) => ({
    file: r[at('filename')] ?? '',
    notes: r[at('notes')] ?? '',
    authors: list(r[at('authors')]),
    licences: list(r[at('licenses')]),
    urls: list(r[at('urls')]),
  }));
}

/** Every credited author once, sorted. */
export function creditedAuthors(rows: readonly CreditRow[]): string[] {
  return [...new Set(rows.flatMap((r) => r.authors))].sort((a, b) => a.localeCompare(b));
}

/** Attribution-only licences, in the order we'd rather use them under. */
const ATTRIBUTION_ONLY = ['OGA-BY', 'CC-BY ', 'CC0'];

/**
 * The licence a layer is used under. A layer listing several licences may be used under any one of them
 * (OpenGameArt's FAQ: follow only one), so the pack takes an attribution-only one; undefined when there is none.
 */
export function usedUnder(licences: readonly string[]): string | undefined {
  for (const prefix of ATTRIBUTION_ONLY) {
    const found = licences.find((licence) => `${licence} `.startsWith(prefix));
    if (found) return found;
  }
  return undefined;
}
