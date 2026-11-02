import { useEffect, useRef } from 'react';
import { HOTKEYS, hotkeyText, modifiers } from '../hotkeys.js';
import { w } from '../theme/words.js';

/** Every key, with the Kingdom numbers as one row and the two older keys that live elsewhere. */
function rows(): { keys: string; what: string }[] {
  return [
    ...HOTKEYS.filter((key) => key.action !== 'kingdom').map((key) => ({ keys: hotkeyText(key), what: key.what() })),
    { keys: `${modifiers(true)}1-9`, what: `That ${w('kingdom')}` },
    { keys: `${modifiers(false)}1-8`, what: `That ${w('belt')} slot, with the panel open` },
    { keys: `${modifiers(false)}←/→`, what: 'Move the focused tab' },
  ];
}

/** The list `Alt+/` opens: a small dialog, not a page. */
export function HotkeyList({ onClose }: { onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 p-4 pt-24" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Keyboard shortcuts"
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-md overflow-hidden rounded-lg border border-neutral-300 bg-white shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
      >
        <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
          <h2 className="cb-display text-xl">Keyboard shortcuts</h2>
          <button
            ref={close}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded px-2 text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-800"
          >
            ×
          </button>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-4 py-3 text-sm">
          {rows().map(({ keys, what }) => (
            <div key={keys} className="contents">
              <dt className="whitespace-nowrap font-mono text-xs leading-5 text-neutral-500">{keys}</dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
