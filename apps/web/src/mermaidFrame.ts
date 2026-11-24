/**
 * The page Mermaid draws in: a sandboxed frame with an opaque origin, served by the hub under its own CSP, so a flaw in
 * Mermaid can't run script in the app (docs/LIBRARY.md, "Read the Tomes"). The parent sends a diagram's source; the SVG
 * stays in this page, and only its height or an error goes back.
 */
import mermaid, { type MermaidConfig } from 'mermaid';

export type FrameTheme = 'light' | 'dark';

/** What the parent may ask: draw this source in this theme. `id` is the parent's, echoed back. */
interface RenderRequest {
  type: 'render';
  id: string;
  source: string;
  theme: FrameTheme;
}

/** Mermaid's own `secure` keys (its `defaultConfig`), which `secure` replaces rather than extends. */
const MERMAID_SECURE = ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges'];

/**
 * Mermaid at its strict level, drawing only when asked. A diagram's `%%{init}%%` block can't change a `secure` key, so
 * it can't set styles or fonts either.
 */
export function mermaidConfig(theme: FrameTheme): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: theme === 'dark' ? 'dark' : 'default',
    secure: [...MERMAID_SECURE, 'themeCSS', 'themeVariables', 'fontFamily', 'altFontFamily', 'fontSize'],
  };
}

function isRenderRequest(data: unknown): data is RenderRequest {
  if (typeof data !== 'object' || data === null) return false;
  const message = data as Record<string, unknown>;
  return (
    message.type === 'render' &&
    typeof message.id === 'string' &&
    typeof message.source === 'string' &&
    (message.theme === 'light' || message.theme === 'dark')
  );
}

/**
 * Posts to the parent. The frame's origin is opaque, so it can't name the parent's origin as the target; `'*'` is safe
 * because nothing sent carries a secret (a height or Mermaid's error message), and the parent checks `event.source`.
 */
function tell(
  message:
    | { type: 'ready' }
    | { type: 'height'; id: string; height: number }
    | {
        type: 'error';
        id: string;
        message: string;
      },
): void {
  window.parent.postMessage(message, '*');
}

let drawn = 0;

/** Draws what the parent asks, and nothing anyone else sends. */
export async function handleMessage(event: MessageEvent): Promise<void> {
  if (event.source !== window.parent || !isRenderRequest(event.data)) return;
  const { id, source, theme } = event.data;
  const target = document.getElementById('diagram') ?? document.body.appendChild(document.createElement('div'));
  try {
    mermaid.initialize(mermaidConfig(theme));
    drawn += 1;
    const { svg } = await mermaid.render(`diagram-${drawn}`, source);
    // Tome text becomes markup here on purpose, and this is the one place it may: Mermaid's strict level sanitises the
    // SVG, and this page runs in a sandbox with an opaque origin and a CSP that allows no requests, so even a flaw in
    // Mermaid reaches neither the app nor the network (proved by scripts/browser/sandbox.spec.ts; docs/LIBRARY.md).
    target.innerHTML = svg;
    // The diagram's own box, not the page's scroll height: that never drops below the frame's viewport, so a frame
    // grown for a tall diagram would stay tall. The page's body has no margin to add (mermaid-frame.html).
    tell({ type: 'height', id, height: Math.ceil(target.getBoundingClientRect().height) });
  } catch (error) {
    target.replaceChildren();
    tell({ type: 'error', id, message: error instanceof Error ? error.message : String(error) });
  }
}

window.addEventListener('message', (event) => void handleMessage(event));
tell({ type: 'ready' });
