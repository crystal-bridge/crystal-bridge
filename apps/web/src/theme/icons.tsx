/**
 * The app's icons (the Quest toolbar, the Inventory's categories), in one place so a theme can swap them. Each is a 16px
 * line drawing in its own colour (`.cb-icon-<name>` in theme.css); the button around it carries the name (aria-label)
 * and the tooltip.
 */
import type { ReactNode } from 'react';

export type IconName =
  'fork' | 'close' | 'split' | 'exitSplit' | 'inventory' | 'details' | 'spells' | 'items' | 'equipment' | 'abilities';

function Svg({ name, children }: { name: IconName; children: ReactNode }) {
  return (
    <svg
      className={`cb-icon cb-icon-${name}`}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

const ICONS: Record<IconName, ReactNode> = {
  // Two branches leaving one trunk, as version control draws a fork.
  fork: (
    <>
      <circle cx="4" cy="3" r="1.5" />
      <circle cx="12" cy="3" r="1.5" />
      <circle cx="8" cy="13" r="1.5" />
      <path d="M4 4.5v1.5a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V4.5M8 8v3.5" />
    </>
  ),
  // A door left ajar: leave the Quest for good.
  close: (
    <>
      <path d="M3 14.5h10M4.5 14.5V2h7v12.5" />
      <path d="M4.5 2l4 1.5v11" />
      <circle cx="7.2" cy="8.5" r="0.4" fill="currentColor" />
    </>
  ),
  // Two panes side by side.
  split: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M8 2.5v11" />
    </>
  ),
  // One pane again.
  exitSplit: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M5 8h6" />
    </>
  ),
  // A satchel.
  inventory: (
    <>
      <path d="M2.5 6h11v7a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 13z" />
      <path d="M5.5 6V4.5a2.5 2.5 0 0 1 5 0V6M2.5 8.5h11" />
    </>
  ),
  // A window with its side panel.
  details: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M10 2.5v11" />
    </>
  ),
  // Spells (skills): a four-point sparkle.
  spells: <path d="M8 1.5l1.6 4.9 4.9 1.6-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6z" />,
  // Items (slash commands, used once): a potion flask.
  items: (
    <>
      <path d="M6 1.5h4M6.5 1.5v4L3 12.5a1.3 1.3 0 0 0 1.2 2h7.6a1.3 1.3 0 0 0 1.2-2L9.5 5.5v-4" />
      <path d="M4.5 10h7" />
    </>
  ),
  // Equipment (MCP servers and plugins, always on): a shield.
  equipment: <path d="M8 1.5l5.5 2v4c0 3.4-2.3 5.8-5.5 7-3.2-1.2-5.5-3.6-5.5-7v-4z" />,
  // Abilities (hooks, which fire by themselves): a lightning bolt.
  abilities: <path d="M9 1.5L3.5 9h4L7 14.5 12.5 7h-4z" />,
};

export function Icon({ name }: { name: IconName }) {
  return <Svg name={name}>{ICONS[name]}</Svg>;
}
