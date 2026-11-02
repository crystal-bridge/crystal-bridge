import { type KeyboardEvent, useState } from 'react';

const MAX_SUGGESTIONS = 8;

/** While the draft is just "/name", the matching commands, and the keys that move through and take one. */
export function useSlashMenu(draft: string, commands: readonly string[], setDraft: (text: string) => void) {
  const [highlight, setHighlight] = useState(0);
  const query = /^\/(\S*)$/.exec(draft)?.[1]?.toLowerCase();
  const suggestions =
    query === undefined ? [] : commands.filter((c) => c.toLowerCase().includes(query)).slice(0, MAX_SUGGESTIONS);
  function complete(command: string) {
    setDraft(`/${command} `);
    setHighlight(0);
  }
  /** Handles a key the open menu wants; false leaves it to the box. */
  function onKey(event: KeyboardEvent): boolean {
    if (suggestions.length === 0) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setHighlight((h) => (h + step + suggestions.length) % suggestions.length);
      return true;
    }
    if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey)) {
      event.preventDefault();
      complete(suggestions[Math.min(highlight, suggestions.length - 1)]!);
      return true;
    }
    return false;
  }
  return { suggestions, highlight, complete, onKey, reset: () => setHighlight(0) };
}

/** The list above the prompt box. */
export function SlashMenu({
  menu,
}: {
  menu: Pick<ReturnType<typeof useSlashMenu>, 'suggestions' | 'highlight' | 'complete'>;
}) {
  if (menu.suggestions.length === 0) return null;
  return (
    <ul
      role="listbox"
      aria-label="Slash commands"
      className="mx-3 mb-1 max-h-60 overflow-y-auto rounded border md:mx-auto md:w-full md:max-w-3xl border-neutral-300 bg-white text-sm shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
    >
      {menu.suggestions.map((command, i) => (
        <li
          key={command}
          role="option"
          aria-selected={i === menu.highlight}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => menu.complete(command)}
          className={`cursor-pointer px-2 py-1 font-mono ${i === menu.highlight ? 'bg-blue-600 text-white' : 'hover:bg-neutral-100 dark:hover:bg-neutral-800'}`}
        >
          /{command}
        </li>
      ))}
    </ul>
  );
}
