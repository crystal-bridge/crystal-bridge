import { LEAVE_COMMAND } from '@crystal-bridge/protocol';
import { w } from '../theme/words.js';

/**
 * What's left to do after removing a Kingdom. Shown above the page, not on the Castle: a Kingdom with no Quests vanishes
 * once it disconnects, and the command must not vanish with it.
 */
export function RemovedKingdom({ name, onDismiss }: { name: string; onDismiss: () => void }) {
  return (
    <div
      role="status"
      className="flex items-start gap-3 bg-neutral-200 px-4 py-1.5 text-sm text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
    >
      <p className="min-w-0 flex-1">
        {`${name} is no longer a ${w('kingdom')}. To uninstall it from that machine, run there: `}
        <code className="select-all break-all text-xs">{LEAVE_COMMAND}</code>
      </p>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded bg-black/10 px-2 font-medium hover:bg-black/20"
      >
        Dismiss
      </button>
    </div>
  );
}
