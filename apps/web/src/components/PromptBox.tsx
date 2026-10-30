import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { addFiles } from '../attachments.js';
import { Icon } from '../theme/icons.js';

/**
 * The prompt box (#15): a text box that starts one line tall and grows to five before it scrolls, a bar of controls
 * under it (settings for what you send next), and one button that is Stop while a turn runs and the box is empty,
 * Send (or `sendLabel`) otherwise (a follow-up sent mid-turn queues), or Run for a shell command. It sits inside the caller's <form>,
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
  sendLabel = 'Send',
  minRows = 1,
  sendDisabled = false,
  files,
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
  /** What sending does, e.g. Start on New Quest. */
  sendLabel?: string;
  /** How tall the box is at rest, in lines. */
  minRows?: number;
  /** Sending isn't possible yet for a reason other than an empty box (e.g. no project picked). */
  sendDisabled?: boolean;
  /** Files to send with the prompt (#14): a + to pick them, paste for images, a chip each. */
  files?: { list: File[]; onChange: (files: File[]) => void };
}) {
  const [fileError, setFileError] = useState<string | undefined>(undefined);
  function add(adding: File[]) {
    if (!files || adding.length === 0) return;
    const next = addFiles(files.list, adding);
    setFileError(next.error);
    files.onChange(next.files);
  }
  const box = useRef<HTMLTextAreaElement>(null);
  // Fit the text: one line at rest, up to the CSS max-height (five lines), then it scrolls.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  const empty = value.trim() === '' && !files?.list.length;
  const stop = running && empty;
  const name = stop ? 'Stop' : shell ? 'Run' : sendLabel;
  return (
    <div className="cb-prompt" data-shell={shell ? 'true' : undefined}>
      {files && files.list.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 px-1 pt-1" aria-label="Attached files">
          {files.list.map((file, i) => (
            <li key={`${file.name}-${i}`} className="cb-chip">
              <Icon name="attach" size={10} />
              <span className="max-w-40 truncate">{file.name}</span>
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                onClick={() => files.onChange(files.list.filter((_, j) => j !== i))}
                className="opacity-60 hover:opacity-100"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {fileError && (
        <p role="alert" className="px-1 text-xs text-red-600 dark:text-red-400">
          {fileError}
        </p>
      )}
      <textarea
        ref={box}
        aria-label={label}
        data-shell={shell ? 'true' : undefined}
        rows={minRows}
        placeholder={placeholder}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          const pasted = [...(e.clipboardData?.files ?? [])];
          if (!files || pasted.length === 0) return;
          e.preventDefault();
          add(pasted);
        }}
        className={shell ? 'font-mono' : undefined}
      />
      <div className="cb-prompt-bar">
        {files && (
          <label className="cb-attach" title="Attach files (images, logs, documents)">
            <Icon name="attach" size={14} />
            <input
              type="file"
              multiple
              aria-label="Attach files"
              className="sr-only"
              onChange={(e) => {
                add([...(e.target.files ?? [])]);
                e.target.value = '';
              }}
            />
          </label>
        )}
        {controls}
        <span className="flex-1" />
        <button
          type={stop ? 'button' : 'submit'}
          aria-label={name}
          title={stop ? 'Stop this turn' : running ? `${name} (queues after this turn)` : name}
          disabled={disabled || (!stop && (empty || sendDisabled))}
          onClick={stop ? onStop : undefined}
          data-kind={stop ? 'stop' : shell ? 'run' : 'send'}
          className="cb-prompt-go"
        >
          <Icon name={stop ? 'stop' : 'send'} size={16} />
        </button>
      </div>
    </div>
  );
}
