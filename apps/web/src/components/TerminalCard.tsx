import { type FormEvent, useState } from 'react';

export interface TerminalCardProps {
  /** What's on the terminal now. */
  text: string;
  /** A message of the user's is waiting behind this, and can be typed again. */
  held: boolean;
  onKeys: (input: { keys?: string; retype?: boolean }) => void;
}

/** The sequences a terminal receives for these keys. */
const KEYS = [
  { label: '↑', name: 'Up', keys: '\x1b[A' },
  { label: '↓', name: 'Down', keys: '\x1b[B' },
  { label: '←', name: 'Left', keys: '\x1b[D' },
  { label: '→', name: 'Right', keys: '\x1b[C' },
  { label: 'Enter', name: 'Enter', keys: '\r' },
  { label: 'Esc', name: 'Esc', keys: '\x1b' },
  ...['1', '2', '3', '4'].map((digit) => ({ label: digit, name: digit, keys: digit })),
];

/**
 * A screen only the terminal shows: a setup dialog, an offer, whatever a new CLI release brings. It's passed through
 * rather than recognised, because that list never ends, so this draws the screen and sends keys.
 */
export function TerminalCard({ text, held, onKeys }: TerminalCardProps) {
  const [typed, setTyped] = useState('');
  const key = 'rounded bg-black/30 px-3 py-1 font-mono text-sm text-white hover:bg-black/50';

  function send(event: FormEvent) {
    event.preventDefault();
    if (!typed) return;
    onKeys({ keys: `${typed}\r` });
    setTyped('');
  }

  return (
    <div className="cb-window p-3">
      <div className="mb-2 text-sm text-gold-bright">This Quest’s terminal is asking something</div>
      <pre aria-label="Terminal screen" className="mb-3 overflow-x-auto rounded bg-black/30 p-2 text-xs text-white">
        {text || 'The terminal shows nothing yet.'}
      </pre>
      <div className="mb-2 flex flex-wrap gap-1">
        {KEYS.map(({ label, name, keys }) => (
          <button key={name} type="button" aria-label={name} className={key} onClick={() => onKeys({ keys })}>
            {label}
          </button>
        ))}
      </div>
      <form onSubmit={send} className="flex flex-wrap gap-2">
        <input
          aria-label="Type into the terminal"
          value={typed}
          maxLength={200}
          onChange={(event) => setTyped(event.target.value)}
          className="min-w-0 flex-1 rounded bg-black/30 px-2 py-1 font-mono text-sm text-white"
        />
        <button type="submit" className={key}>
          Type
        </button>
        {held && (
          <button type="button" className={key} onClick={() => onKeys({ retype: true })}>
            Send my message again
          </button>
        )}
      </form>
    </div>
  );
}
