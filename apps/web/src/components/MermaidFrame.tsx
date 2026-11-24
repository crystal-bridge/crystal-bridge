import { useEffect, useId, useRef, useState } from 'react';

/** The page Mermaid draws in (mermaid-frame.html), served by the hub under its own CSP. */
export const MERMAID_FRAME_URL = '/sandbox/mermaid-frame.html';
/** No diagram is drawn taller than this, whatever the frame says. */
const MAX_HEIGHT = 4000;

type Scheme = 'light' | 'dark';

const DARK = '(prefers-color-scheme: dark)';
const scheme = (): Scheme =>
  typeof window.matchMedia === 'function' && window.matchMedia(DARK).matches ? 'dark' : 'light';

/** The colour scheme the app follows (its stylesheet's `prefers-color-scheme`), kept up to date. */
function useScheme(): Scheme {
  const [current, setCurrent] = useState(scheme);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(DARK);
    const change = () => setCurrent(scheme());
    query.addEventListener?.('change', change);
    return () => query.removeEventListener?.('change', change);
  }, []);
  return current;
}

/**
 * A Mermaid diagram, drawn inside its own sandboxed frame with an opaque origin (docs/LIBRARY.md, "Read the Tomes"):
 * the source goes in by `postMessage`, and only the drawing's height or Mermaid's error comes back. Messages count only
 * from this frame's window and for the request last sent, so another frame (or an older drawing) can't size this one.
 * A diagram that fails shows its source and the error.
 */
export function MermaidFrame({ source }: { source: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const base = useId();
  const ready = useRef(false);
  const sent = useRef(0);
  const theme = useScheme();
  const [height, setHeight] = useState<number>();
  const [error, setError] = useState<string>();
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    let current = '';
    const draw = () => {
      sent.current += 1;
      current = `${base}-${sent.current}`;
      // The frame's origin is opaque, so it can't be named as the target; the source is the Tome's own text.
      frame.current?.contentWindow?.postMessage({ type: 'render', id: current, source, theme }, '*');
    };
    const onMessage = (event: MessageEvent) => {
      const own = frame.current?.contentWindow;
      if (!own || event.source !== own) return;
      const data: unknown = event.data;
      if (typeof data !== 'object' || data === null) return;
      const message = data as Record<string, unknown>;
      if (message.type === 'ready') {
        ready.current = true;
        draw();
        return;
      }
      if (message.id !== current) return;
      if (message.type === 'height' && typeof message.height === 'number' && Number.isFinite(message.height)) {
        setHeight(Math.min(MAX_HEIGHT, Math.max(0, Math.ceil(message.height))));
        setError(undefined);
      } else if (message.type === 'error') {
        setError(String(message.message ?? 'The diagram could not be drawn.').slice(0, 500));
      }
    };
    window.addEventListener('message', onMessage);
    if (ready.current) draw();
    return () => window.removeEventListener('message', onMessage);
  }, [base, source, theme]);

  return (
    <div className="my-3 overflow-hidden rounded border border-neutral-200 dark:border-neutral-800" data-mermaid>
      <div className="flex items-center justify-between bg-neutral-100 px-2 py-1 text-xs text-neutral-500 dark:bg-neutral-900">
        <span className="font-mono">mermaid</span>
        <button
          type="button"
          onClick={() => setShowSource((on) => !on)}
          aria-pressed={showSource}
          className="rounded px-1.5 py-0.5 hover:bg-neutral-200 dark:hover:bg-neutral-800"
        >
          Source
        </button>
      </div>
      {error && (
        <p role="alert" className="px-3 pt-2 text-[12px] text-rose-700 dark:text-rose-300">
          The diagram couldn't be drawn: {error}
        </p>
      )}
      {(showSource || error) && (
        <pre className="my-0! overflow-x-auto bg-neutral-50 px-3 py-2 font-mono text-[13px] dark:bg-neutral-900/50">
          {source}
        </pre>
      )}
      <iframe
        ref={frame}
        src={MERMAID_FRAME_URL}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        title="Mermaid diagram"
        className={`block w-full border-0 bg-transparent ${error ? 'hidden' : ''}`}
        style={{ height: height === undefined ? '9rem' : `${height}px` }}
      />
    </div>
  );
}
