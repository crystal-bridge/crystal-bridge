import { useState } from 'react';
import { goldText, money } from '../format.js';
import { Icon } from '../theme/icons.js';
import { gameLook } from '../theme/words.js';
import { Tip } from './Tip.js';

/** What the figure is: the CLI's API-equivalent cost, not what a subscription bills. */
const NOTE = 'API-equivalent cost, as the CLI reports it';

/**
 * A cost as Gold, one coin per US cent (#29). A tiny info button shows the dollars in a tooltip on hover or focus, and
 * inline on a tap, since phones have no hover. `compact` (one-line summaries) drops the button and says " Gold",
 * keeping the dollars in the title. The Classic theme shows dollars.
 */
export function Gold({ usd, compact = false }: { usd: number; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!gameLook) return <>{money(usd)}</>;
  const dollars = `${money(usd)} (${NOTE})`;
  if (compact) return <span title={dollars}>{goldText(usd)} Gold</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1">
      {goldText(usd)}
      {open && <span className="cb-gold-usd text-neutral-500">{money(usd)}</span>}
      <Tip text={dollars} align="end">
        <button
          type="button"
          aria-label="Gold in US dollars"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="inline-grid place-items-center rounded-full text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
        >
          <Icon name="info" size={11} />
        </button>
      </Tip>
    </span>
  );
}
