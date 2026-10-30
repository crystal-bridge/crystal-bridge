import { useEffect, useRef } from 'react';
import { COMPANIONS } from '../theme/companions.js';

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** How long each of the two idle frames (up, down a pixel) shows. */
const BOB_MS = 450;

/**
 * A Side Quest companion (theme/companions.ts) drawn from its pixel grid, bobbing a pixel on a two-frame idle unless
 * the device asks for reduced motion.
 */
export function CompanionSprite({ id, label, size = 32 }: { id: string; label: string; size?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const companion = COMPANIONS[id];

  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!companion || !ctx) return;
    // Draw at device resolution so pixels stay square and crisp.
    const ratio = globalThis.devicePixelRatio || 1;
    canvas.current!.width = size * ratio;
    canvas.current!.height = size * ratio;
    const px = (size * ratio) / 16;
    let down = false;
    const draw = () => {
      ctx.clearRect(0, 0, size * ratio, size * ratio);
      companion.rows.forEach((row, y) => {
        [...row].forEach((ch, x) => {
          const colour = companion.palette[ch];
          if (!colour) return;
          ctx.fillStyle = colour;
          ctx.fillRect(Math.round(x * px), Math.round((y + (down ? 1 : 0)) * px), Math.ceil(px), Math.ceil(px));
        });
      });
      down = !down;
    };
    draw();
    if (reducedMotion()) return;
    const timer = setInterval(draw, BOB_MS);
    return () => clearInterval(timer);
  }, [companion, size]);

  if (!companion) return null;
  return (
    <canvas
      ref={canvas}
      role="img"
      aria-label={label}
      title={label}
      data-companion={id}
      width={size}
      height={size}
      style={{ width: size, height: size, imageRendering: 'pixelated' }}
      className="shrink-0"
    />
  );
}
