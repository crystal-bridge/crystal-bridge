import { joinCommand } from '@crystal-bridge/protocol';
import { type FormEvent, useState } from 'react';
import { w } from '../theme/words.js';

const NODE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/i;

/** Asks the hub for a join code, and shows the one command that brings a new machine in. */
export function AddKingdom({
  hub,
  onCreate,
}: {
  /** This hub's web address, as a new machine would reach it. */
  hub: string;
  onCreate: (node: string) => Promise<{ code: string; expiresAt: number }>;
}) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setCommand(null);
    setCopied(false);
    if (!NODE_ID.test(name)) {
      setError('Use letters, digits and dashes.');
      return;
    }
    setError(null);
    try {
      const { code } = await onCreate(name);
      setCommand(joinCommand(hub, code));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  async function copy(): Promise<void> {
    if (!command) return;
    await navigator.clipboard.writeText(command);
    setCopied(true);
  }

  return (
    <div className="space-y-2 rounded-md bg-neutral-100 p-2 dark:bg-neutral-800">
      <form onSubmit={(event) => void submit(event)} className="flex items-center gap-2">
        <input
          aria-label={`Name for the new ${w('kingdom')}`}
          placeholder={`New ${w('kingdom')}`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="cb-field min-w-0 flex-1 py-0.5"
        />
        <button
          type="submit"
          className="shrink-0 rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
        >
          {`Add ${w('kingdom')}`}
        </button>
      </form>
      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {command && (
        <>
          <p className="text-xs text-neutral-500">
            Run this on the new machine within 10 minutes. It needs Node 22+ and Claude Code signed in, and works once.
          </p>
          <code aria-label="Install command" className="block select-all break-all rounded bg-black/10 p-1.5 text-xs">
            {command}
          </code>
          <button
            type="button"
            onClick={() => void copy()}
            className="rounded border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-200 dark:border-neutral-600 dark:hover:bg-neutral-700"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </>
      )}
    </div>
  );
}
