import { useEffect, useRef } from 'react';
import { type HeroManifest, type HeroState, heroAnimation } from '../heroes.js';

/**
 * A Hero drawn from the art pack: a pixelated canvas that plays its Class's strip for its state. The canvas frames a
 * 64px body; oversize attack frames (128px) are drawn centred on it and may overflow its edges.
 */
export interface HeroSpriteProps {
  manifest: HeroManifest;
  classId: string;
  state: HeroState;
  /** Displayed size in CSS pixels. */
  size?: number;
  /** Hidden from assistive tech, e.g. inside a tab whose name already says what it is; the tooltip stays. */
  decorative?: boolean;
}

const STATE_LABEL: Record<HeroState, string | null> = {
  resting: 'resting',
  working: null, // the Class's own verb
  alert: 'needs you',
  victory: 'turn done',
  ko: 'failed',
};

// Images are shared across sprites and loaded on first use; drawing just skips a frame until one is ready.
const images = new Map<string, HTMLImageElement>();
function strip(classId: string, anim: string): HTMLImageElement {
  const key = `${classId}/${anim}`;
  let img = images.get(key);
  if (!img) {
    img = new Image();
    img.src = `/heroes/${key}.png`;
    images.set(key, img);
  }
  return img;
}

// One animation loop for every sprite on the page.
type Draw = (now: number) => void;
const draws = new Set<Draw>();
let frame = 0;
function tick(now: number) {
  for (const draw of draws) draw(now);
  frame = draws.size > 0 ? requestAnimationFrame(tick) : 0;
}
function onFrame(draw: Draw): () => void {
  draws.add(draw);
  if (!frame && typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(tick);
  return () => draws.delete(draw);
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function HeroSprite({ manifest, classId, state, size = 32, decorative = false }: HeroSpriteProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const cls = manifest.classes[classId];

  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!cls || !ctx) return;
    const play = heroAnimation(cls, state);
    const frames = cls.anims[play.anim];
    if (!frames) return;
    const started = performance.now();
    const still = reducedMotion();
    // Draw at device resolution so pixels stay square and crisp.
    const scale = (size * (globalThis.devicePixelRatio || 1)) / 64;
    const px = Math.max(1, Math.round(scale));
    ctx.canvas.width = 64 * px;
    ctx.canvas.height = 64 * px;
    ctx.imageSmoothingEnabled = false;

    return onFrame((now) => {
      const img = strip(classId, play.anim);
      if (!img.complete || img.naturalWidth === 0) return;
      let f = Math.floor((now - started) / play.ms);
      if (still) f = play.anim === 'hurt' ? frames.frames - 1 : (play.hold ?? 0);
      else if (play.hold !== undefined) f = Math.min(f, play.hold);
      else if (play.loop) f %= frames.frames;
      else f = Math.min(f, frames.frames - 1);
      const s = frames.size;
      const offset = ((s - 64) / 2) * px;
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.drawImage(img, f * s, 0, s, s, -offset, -offset, s * px, s * px);
      if (play.bubble) {
        const bob = still ? 0 : Math.round(Math.sin((now - started) / 180));
        ctx.fillStyle = '#ffd75e';
        ctx.fillRect(41 * px, (4 + bob) * px, 9 * px, 11 * px);
        ctx.fillStyle = '#121b63';
        ctx.fillRect(44 * px, (6 + bob) * px, 3 * px, 5 * px);
        ctx.fillRect(44 * px, (12 + bob) * px, 3 * px, 2 * px);
      }
      if (play.sparkle && !still) {
        ctx.fillStyle = '#ffd75e';
        const t = (now - started) / 270;
        for (let i = 0; i < 4; i++) {
          const a = t + (i * Math.PI) / 2;
          ctx.fillRect(Math.round(32 + Math.cos(a) * 20) * px, Math.round(18 + Math.sin(a) * 9) * px, 2 * px, 2 * px);
        }
      }
    });
  }, [cls, classId, state, size]);

  if (!cls) return null;
  return (
    <canvas
      ref={canvas}
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : `${cls.name}, ${STATE_LABEL[state] ?? cls.verb}`}
      title={`${cls.name}, ${STATE_LABEL[state] ?? cls.verb}`}
      data-class={classId}
      data-state={state}
      width={size}
      height={size}
      style={{ width: size, height: size, imageRendering: 'pixelated' }}
      className="shrink-0"
    />
  );
}
