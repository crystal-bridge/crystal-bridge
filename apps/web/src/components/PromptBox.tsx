import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef } from 'react';
import { Icon } from '../theme/icons.js';

/**
 * The prompt box (#15): a text box that starts one line tall and grows to five before it scrolls, a bar of controls
 * under it (settings for what you send next), and one button that is Stop while a turn runs and the box is empty,
 * Send otherwise (a follow-up sent mid-turn queues), or Run for a shell command. It sits inside the caller's <form>,
 * which handles the send.
 */
export function PromptBox({
  label,
  value,
  onChange,
  onKeyDown,
  placeholder,
  disabled,
  shell,
  running,
  onStop,
  controls,
}: {
  /** The text box's accessible name. */
  label: string;
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  disabled?: boolean;
  /** The text is a shell command (the Command Rune): the box turns rose and the button says Run. */
  shell?: boolean;
  /** A turn is running, so an empty box offers Stop. */
  running: boolean;
  onStop: () => void;
  /** Left side of the bar under the box. */
  controls?: ReactNode;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  // Fit the text: one line at rest, up to the CSS max-height (five lines), then it scrolls.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  const empty = value.trim() === '';
  const stop = running && empty;
  const name = stop ? 'Stop' : shell ? 'Run' : 'Send';
  return (
    <div className="cb-prompt" data-shell={shell ? 'true' : undefined}>
      <textarea
        ref={box}
        aria-label={label}
        data-shell={shell ? 'true' : undefined}
        rows={1}
        placeholder={placeholder}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        className={shell ? 'font-mono' : undefined}
      />
      <div className="cb-prompt-bar">
        {controls}
        <span className="flex-1" />
        <button
          type={stop ? 'button' : 'submit'}
          aria-label={name}
          title={stop ? 'Stop this turn' : running ? `${name} (queues after this turn)` : name}
          disabled={disabled || (!stop && empty)}
          onClick={stop ? onStop : undefined}
          data-kind={stop ? 'stop' : shell ? 'run' : 'send'}
          className="cb-prompt-go"
        >
          <Icon name={stop ? 'stop' : 'send'} size={18} />
        </button>
      </div>
    </div>
  );
}
