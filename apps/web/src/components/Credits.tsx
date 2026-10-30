import { useState } from 'react';
import { creditedAuthors, type CreditRow, parseCredits, usedUnder } from '../credits.js';
import { ICON_PACKS, iconAuthors, type IconPack } from '../theme/iconSources.js';

/** The bundled fonts, all under the SIL Open Font License 1.1. */
const FONTS = [
  { name: 'Jersey 15', by: 'The Soft Type Project Authors' },
  { name: 'Atkinson Hyperlegible', by: 'Braille Institute of America' },
  { name: 'JetBrains Mono', by: 'The JetBrains Mono Project Authors' },
];

/** "A, B and C". */
function list(names: string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * Who made what the app shows: the Hero art's artists and layers (from CREDITS.csv, fetched only when opened), the
 * icon packs and the bundled fonts. The full third-party list is THIRD_PARTY_NOTICES.md in the repo.
 */
export function Credits() {
  const [rows, setRows] = useState<CreditRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  function load(open: boolean) {
    if (!open || rows) return;
    fetch('/heroes/CREDITS.csv')
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(String(res.status)))))
      .then((text) => setRows(parseCredits(text)))
      .catch(() => setFailed(true));
  }

  return (
    <details onToggle={(e) => load((e.currentTarget as HTMLDetailsElement).open)} className="text-xs">
      <summary className="cursor-pointer select-none font-medium">Credits</summary>
      <div className="mt-2 space-y-3">
        <section>
          <h4 className="font-medium">Hero art</h4>
          <p className="text-neutral-500">
            Composited from the Liberated Pixel Cup (LPC) sprite layers, each used under an attribution licence (OGA-BY,
            CC-BY or CC0). Thank you to:
          </p>
          {failed && <p className="text-red-600">Couldn't load the art credits.</p>}
          {rows && (
            <>
              <p className="mt-1">{creditedAuthors(rows).join(', ')}</p>
              <details className="mt-1">
                <summary className="cursor-pointer select-none text-neutral-500">
                  Every layer, with its authors and licences ({rows.length})
                </summary>
                <ul className="mt-1 max-h-64 space-y-1 overflow-y-auto">
                  {rows.map((row) => (
                    <li key={row.file}>
                      <span className="font-mono">{row.file}</span>
                      <span className="block text-neutral-500">
                        {row.authors.join(', ')} · used under {usedUnder(row.licences) ?? row.licences.join(', ')}{' '}
                        (offered as {row.licences.join(', ')})
                        {row.urls.map((url) => (
                          <a key={url} href={url} target="_blank" rel="noreferrer" className="ml-1 underline">
                            source
                          </a>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            </>
          )}
        </section>
        <section>
          <h4 className="font-medium">Icons</h4>
          <ul>
            {(Object.keys(ICON_PACKS) as IconPack[]).map((id) => {
              const pack = ICON_PACKS[id];
              const authors = iconAuthors(id);
              return (
                <li key={id}>
                  <a href={pack.url} target="_blank" rel="noreferrer" className="underline">
                    {pack.name}
                  </a>
                  {authors.length > 0 && `, by ${list(authors)}`} ({pack.licence})
                </li>
              );
            })}
          </ul>
        </section>
        <section>
          <h4 className="font-medium">Fonts</h4>
          <ul>
            {FONTS.map((font) => (
              <li key={font.name}>
                {font.name}, by {font.by} (SIL Open Font License 1.1)
              </li>
            ))}
          </ul>
        </section>
        <p className="text-neutral-500">
          Every other open-source package Crystal Bridge ships, with its licence, is in THIRD_PARTY_NOTICES.md.
        </p>
      </div>
    </details>
  );
}
