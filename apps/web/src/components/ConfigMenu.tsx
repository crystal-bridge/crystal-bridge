import { useEffect, useRef, useState } from 'react';
import { TAB_STYLES, type KingdomLook, type TabStyle } from '../appearance.js';
import { hint, w } from '../theme/words.js';
import type { Kingdom } from '../kingdoms.js';
import { NOTIFY_LEVELS, type NotifyLevel } from '../notify.js';
import { BANNER_COLOURS, KINGDOM_ICONS } from '../theme/kingdomIcons.js';
import { Credits } from './Credits.js';
import { DevicePush, type PushState } from './DevicePush.js';
import { KingdomIcon } from './KingdomIcon.js';

export interface ConfigMenuProps {
  visible: Kingdom[];
  hidden: Kingdom[];
  onRename: (id: string, name: string) => void;
  onToggleHidden: (id: string) => void;
  /** This device's notification level per Kingdom; unset means full. */
  notify: Record<string, NotifyLevel>;
  onNotify: (id: string, level: NotifyLevel) => void;
  /** The hub link's state, e.g. open or connecting. */
  status: string;
  /** The browser's notification permission, or `unsupported`. */
  canNotify: string;
  onEnableNotifications: () => void;
  push: PushState;
  pushError?: string | undefined;
  onPush: (on: boolean) => void;
  /** Each Kingdom's icon and colour on this device. */
  looks?: Record<string, KingdomLook>;
  /** Sets one field of a Kingdom's look on this device. */
  onLook?: (id: string, change: Partial<KingdomLook>) => void;
  tabStyle?: TabStyle;
  onTabStyle?: (style: TabStyle) => void;
}

/** One Kingdom's look: an icon grid and banner swatches, both data lists in theme/kingdomIcons.ts. */
function LookPicker({
  kingdom,
  look,
  onLook,
}: {
  kingdom: Kingdom;
  look: KingdomLook;
  onLook: (id: string, change: Partial<KingdomLook>) => void;
}) {
  return (
    <div className="space-y-2 rounded-md bg-neutral-100 p-2 dark:bg-neutral-800">
      <div role="group" aria-label={`Icon for ${kingdom.id}`} className="flex flex-wrap gap-1">
        {KINGDOM_ICONS.map((icon) => (
          <button
            key={icon.id}
            type="button"
            aria-label={icon.label}
            title={icon.label}
            aria-pressed={icon.id === look.icon}
            onClick={() => onLook(kingdom.id, { icon: icon.id })}
            className={`rounded border p-1 ${
              icon.id === look.icon
                ? 'border-blue-600 ring-1 ring-blue-600'
                : 'border-neutral-300 hover:border-neutral-500 dark:border-neutral-600'
            }`}
          >
            <KingdomIcon icon={icon.id} colour={look.colour} size={24} />
          </button>
        ))}
      </div>
      <div role="group" aria-label={`Banner colour for ${kingdom.id}`} className="flex flex-wrap gap-1.5">
        {BANNER_COLOURS.map((colour) => (
          <button
            key={colour.id}
            type="button"
            aria-label={colour.label}
            title={colour.label}
            aria-pressed={colour.hex === look.colour}
            onClick={() => onLook(kingdom.id, { colour: colour.hex })}
            style={{ background: colour.hex }}
            className={`h-6 w-6 rounded-full border-2 border-white dark:border-neutral-900 ${
              colour.hex === look.colour ? 'ring-2 ring-blue-600' : 'ring-1 ring-neutral-300 dark:ring-neutral-600'
            }`}
          />
        ))}
      </div>
    </div>
  );
}

function GearIcon() {
  // A pixel gear, drawn on a 16-cell grid to match the crystal logo.
  const cells = [
    [7, 1, 2, 2],
    [3, 3, 2, 2],
    [11, 3, 2, 2],
    [1, 7, 2, 2],
    [13, 7, 2, 2],
    [3, 11, 2, 2],
    [11, 11, 2, 2],
    [7, 13, 2, 2],
    [5, 4, 6, 1],
    [4, 5, 8, 6],
    [5, 11, 6, 1],
  ];
  return (
    <svg viewBox="0 0 16 16" width="22" height="22" shapeRendering="crispEdges" aria-hidden>
      {cells.map(([x, y, w, h]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={w} height={h} fill="currentColor" />
      ))}
      <rect x={7} y={7} width={2} height={2} className="fill-neutral-200 dark:fill-neutral-800" />
    </svg>
  );
}

/** The app bar's Config menu: this device's Kingdom names, visibility and notifications, and Web Push. */
export function ConfigMenu({
  visible,
  hidden,
  onRename,
  onToggleHidden,
  notify,
  onNotify,
  status,
  canNotify,
  onEnableNotifications,
  push,
  pushError,
  onPush,
  looks = {},
  onLook,
  tabStyle = 'underline',
  onTabStyle,
}: ConfigMenuProps) {
  const [open, setOpen] = useState(false);
  const [styling, setStyling] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const all = [...visible, ...hidden].sort((a, b) => a.id.localeCompare(b.id));
  const hiddenIds = new Set(hidden.map((k) => k.id));

  // A click elsewhere or Escape closes it, as menus do.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative shrink-0 self-center">
      <button
        type="button"
        aria-label={w('config')}
        title={hint('config')}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-md p-1.5 text-neutral-600 hover:bg-neutral-300 hover:text-neutral-950 dark:text-neutral-300 dark:hover:bg-neutral-700 dark:hover:text-white"
      >
        <GearIcon />
        {status !== 'open' && (
          <span title={`hub ${status}`} className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-amber-500" />
        )}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={w('config')}
          className="absolute right-0 top-full z-30 mt-2 w-[min(22rem,calc(100vw-1rem))] space-y-4 rounded-lg border border-neutral-300 bg-white p-4 text-sm shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
        >
          <h2 className="cb-display text-2xl leading-none">{w('config')}</h2>

          <section className="space-y-2">
            <h3 className="text-xs font-bold uppercase tracking-wide text-neutral-500">
              {w('kingdoms')} on this device
            </h3>
            <p className="text-xs text-neutral-500">
              {`Names, visibility and notifications apply to this device only; icons, banner colours and the tab style follow you to all your devices. Discreet notifications name only the ${w(
                'kingdom',
              )}, never a ${w('quest')} or its content.`}
            </p>
            {onTabStyle && (
              <label className="flex items-center gap-2 text-xs">
                <span className="text-neutral-500">Tab style</span>
                <select
                  aria-label="Tab style"
                  value={tabStyle}
                  onChange={(e) => onTabStyle(e.target.value as TabStyle)}
                  className="rounded border border-neutral-300 bg-white px-1 py-0.5 dark:border-neutral-700 dark:bg-neutral-950"
                >
                  {TAB_STYLES.map((style) => (
                    <option key={style.value} value={style.value}>
                      {style.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {all.map((kingdom) => (
              <div key={kingdom.id} className="space-y-1">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    aria-label={`Show ${kingdom.id} on this device`}
                    checked={!hiddenIds.has(kingdom.id)}
                    onChange={() => onToggleHidden(kingdom.id)}
                  />
                  <input
                    aria-label={`Name for ${kingdom.id}`}
                    placeholder={kingdom.id}
                    value={kingdom.name === kingdom.id ? '' : kingdom.name}
                    onChange={(e) => onRename(kingdom.id, e.target.value)}
                    className="min-w-0 flex-1 rounded border border-neutral-300 bg-white px-2 py-0.5 dark:border-neutral-700 dark:bg-neutral-950"
                  />
                  <select
                    aria-label={`Notifications for ${kingdom.id}`}
                    value={notify[kingdom.id] ?? 'full'}
                    onChange={(e) => onNotify(kingdom.id, e.target.value as NotifyLevel)}
                    className="rounded border border-neutral-300 bg-white px-1 py-0.5 text-xs dark:border-neutral-700 dark:bg-neutral-950"
                  >
                    {NOTIFY_LEVELS.map((level) => (
                      <option key={level.value} value={level.value}>
                        {level.label}
                      </option>
                    ))}
                  </select>
                  {onLook && looks[kingdom.id] && (
                    <button
                      type="button"
                      aria-label={`Look for ${kingdom.id}`}
                      title="Icon and banner colour"
                      aria-expanded={styling === kingdom.id}
                      onClick={() => setStyling((id) => (id === kingdom.id ? null : kingdom.id))}
                      className="rounded border border-neutral-300 p-0.5 hover:border-neutral-500 dark:border-neutral-700"
                    >
                      <KingdomIcon icon={looks[kingdom.id]!.icon} colour={looks[kingdom.id]!.colour} size={20} />
                    </button>
                  )}
                </div>
                {onLook && styling === kingdom.id && looks[kingdom.id] && (
                  <LookPicker kingdom={kingdom} look={looks[kingdom.id]!} onLook={onLook} />
                )}
              </div>
            ))}
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-bold uppercase tracking-wide text-neutral-500">Notifications</h3>
            {canNotify === 'default' && (
              <button
                type="button"
                onClick={onEnableNotifications}
                className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
              >
                Enable notifications
              </button>
            )}
            {canNotify === 'denied' && (
              <p className="text-xs text-amber-600">
                Notifications are blocked in this browser. Allow them for this site in the browser&apos;s site settings
                (and for the browser in your OS settings), then reload.
              </p>
            )}
            {canNotify === 'granted' && <p className="text-xs text-neutral-500">Allowed while a tab is open.</p>}
            <DevicePush state={push} error={pushError} onChange={onPush} />
          </section>

          <p className="text-xs text-neutral-500">
            Hub: <span className={status === 'open' ? 'text-green-600' : 'text-amber-600'}>{status}</span>
          </p>

          <Credits />
        </div>
      )}
    </div>
  );
}
