import { usePanel } from '../panels.js';
import { Icon } from '../theme/icons.js';
import { hint, w } from '../theme/words.js';
import { Tip } from './Tip.js';

/** A toolbar button that shows only its icon; its name is the aria-label and the tooltip. */
export const ICON_BUTTON =
  'inline-flex items-center rounded p-1 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-200';

/** The toolbar's Inventory and Details toggles, shared by a Quest and New Quest: wide screens only, like the panels. */
export function PanelToggles() {
  const [inventoryOpen, toggleInventory] = usePanel('inventory');
  const [details, toggleDetails] = usePanel('details');
  return (
    <>
      <Tip text={hint('inventory')} align="end" className="hidden lg:inline-flex">
        <button
          type="button"
          aria-label={w('inventory')}
          onClick={toggleInventory}
          aria-pressed={inventoryOpen}
          className={ICON_BUTTON}
        >
          <Icon name="inventory" />
        </button>
      </Tip>
      <Tip text="Details: the side panel" align="end" className="hidden lg:inline-flex">
        <button
          type="button"
          aria-label="Details"
          onClick={toggleDetails}
          aria-pressed={details}
          className={ICON_BUTTON}
        >
          <Icon name="details" />
        </button>
      </Tip>
    </>
  );
}
