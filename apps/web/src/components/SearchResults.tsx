import type { Envelope } from '@crystal-bridge/protocol';
import { snippet } from '../search.js';

/** One row of `GET /api/search`. */
export interface SearchHit {
  session: string;
  seq: number;
  label: string;
  event: Envelope;
}

/** Matches in the active Kingdom's history; hits that only matched plumbing are dropped. */
export function SearchResults({
  query,
  hits,
  onOpen,
}: {
  query: string;
  hits: SearchHit[];
  onOpen: (session: string) => void;
}) {
  const shown = hits
    .map((hit) => ({ hit, text: snippet(hit.event, query) }))
    .filter((row): row is { hit: SearchHit; text: string } => row.text !== undefined);

  if (shown.length === 0) return <p className="px-3 py-2 text-sm text-neutral-500">No matches for “{query}”</p>;
  return (
    <ul>
      {shown.map(({ hit, text }) => (
        <li key={`${hit.session}:${hit.seq}`}>
          <button
            type="button"
            onClick={() => onOpen(hit.session)}
            className="w-full px-3 py-2 text-left hover:bg-neutral-200 dark:hover:bg-neutral-800"
          >
            <div className="truncate text-sm font-medium">{hit.label}</div>
            <div className="line-clamp-2 text-xs text-neutral-500">{text}</div>
          </button>
        </li>
      ))}
    </ul>
  );
}
