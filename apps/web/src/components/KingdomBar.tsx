import type { CSSProperties } from 'react';
import type { KingdomLook, TabStyle } from '../appearance.js';
import type { Kingdom } from '../kingdoms.js';
import { reorderHandlers } from '../tabOrder.js';
import { hint, w } from '../theme/words.js';
import { KingdomIcon } from './KingdomIcon.js';

export interface KingdomBarProps {
  visible: Kingdom[];
  /** The Kingdom whose tab is selected; null while the Airship (Home) is shown. */
  active: string | null;
  onSelect: (id: string) => void;
  /** Quests waiting on the user, per Kingdom. */
  waiting: Record<string, number>;
  /** Moves a tab to a new position, by drag-and-drop or Alt+Arrow; the order is saved per device. */
  onMove?: (id: string, index: number) => void;
  /** Each Kingdom's icon and colour on this device. */
  looks?: Record<string, KingdomLook>;
  /** How the tabs show their Kingdom's colour (theme.css `.cb-kingdom-tabs`). */
  tabStyle?: TabStyle;
}

/** App-bar tabs, one per Kingdom this device shows, each with its icon and banner colour. Renaming and looks live in Config. */
export function KingdomBar({
  visible,
  active,
  onSelect,
  waiting,
  onMove,
  looks = {},
  tabStyle = 'underline',
}: KingdomBarProps) {
  const ids = visible.map((kingdom) => kingdom.id);
  return (
    <div
      role="tablist"
      aria-label={w('kingdoms')}
      data-tab-style={tabStyle}
      className="cb-kingdom-tabs flex min-w-0 items-end gap-1 overflow-x-auto"
    >
      {visible.map((kingdom) => {
        const selected = kingdom.id === active;
        const look = looks[kingdom.id];
        return (
          <button
            key={kingdom.id}
            type="button"
            role="tab"
            data-kingdom={kingdom.id}
            aria-selected={selected}
            title={`${hint('kingdom')} · ${kingdom.id}${kingdom.connected ? '' : ' · offline'}`}
            onClick={() => onSelect(kingdom.id)}
            {...reorderHandlers(ids, kingdom.id, onMove)}
            style={look ? ({ '--kingdom-colour': look.colour } as CSSProperties) : undefined}
            className={`cb-kingdom-tab cb-display relative flex shrink-0 items-center gap-2 rounded-t-md border-x border-t px-4 pb-1.5 pt-2 text-xl leading-none ${
              selected
                ? 'border-neutral-300 bg-white text-neutral-950 dark:border-neutral-700 dark:bg-neutral-950 dark:text-white'
                : 'border-transparent text-neutral-500 hover:bg-neutral-200 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-200'
            }`}
          >
            {look && <KingdomIcon icon={look.icon} colour={look.colour} size={22} />}
            <span
              data-connected={kingdom.connected}
              title={kingdom.connected ? 'connected' : 'offline'}
              className={`h-2 w-2 rounded-full ${kingdom.connected ? 'bg-green-500' : 'bg-neutral-400'}`}
            />
            {kingdom.name}
            {(waiting[kingdom.id] ?? 0) > 0 && (
              <span
                title={`${w('quests')} waiting on you`}
                className="rounded-full bg-amber-500 px-1.5 font-sans text-xs font-bold leading-4 text-white"
              >
                {waiting[kingdom.id]}
              </span>
            )}
          </button>
        );
      })}
      {visible.length === 0 && (
        <span className="px-3 py-1.5 text-sm text-neutral-500">{`No ${w('kingdoms')} shown`}</span>
      )}
    </div>
  );
}
