/**
 * The app's icons (the Quest toolbar, the Inventory's categories, the prompt box, Stats), in one place so a theme can
 * swap them. Each is a filled drawing from an icon pack (`iconSources.ts` says which; `pnpm icons` copies it into
 * `iconData.ts`) in its own colour (`.cb-icon-<name>` in theme.css); the button around it carries the name
 * (aria-label) and the tooltip.
 */
import { ICON_DATA } from './iconData.js';
import type { IconName } from './iconSources.js';

export type { IconName } from './iconSources.js';

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const { viewBox, paths } = ICON_DATA[name];
  return (
    <svg
      className={`cb-icon cb-icon-${name}`}
      viewBox={viewBox}
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
