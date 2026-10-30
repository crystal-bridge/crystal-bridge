import { KINGDOM_ICONS, iconPixels } from '../theme/kingdomIcons.js';

/** A Kingdom's pixel icon in its banner colour, drawn as crisp 1x1 rects at any size. Decorative. */
export function KingdomIcon({ icon, colour, size = 20 }: { icon: string; colour: string; size?: number }) {
  const data = KINGDOM_ICONS.find((i) => i.id === icon) ?? KINGDOM_ICONS[0]!;
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      shapeRendering="crispEdges"
      aria-hidden
      data-icon={data.id}
      className="cb-kingdom-icon shrink-0"
    >
      {iconPixels(data, colour).map((p) => (
        <rect key={`${p.x}-${p.y}`} x={p.x} y={p.y} width={1} height={1} fill={p.fill} />
      ))}
    </svg>
  );
}
