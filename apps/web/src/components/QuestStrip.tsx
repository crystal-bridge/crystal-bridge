import type { HeroManifest, HeroState } from '../heroes.js';
import { questTitle } from '../quests.js';
import { reorderHandlers } from '../tabOrder.js';
import { hint, w } from '../theme/words.js';
import { HeroSprite } from './HeroSprite.js';
import type { SessionSummary } from './SessionList.js';
import { STATUS_DOT } from './SessionList.js';

export interface QuestStripProps {
  /** Shown on the first tab, the Kingdom's home. */
  castleName: string;
  /** The Quests that get a tab, in order (see `questTabs`). */
  quests: SessionSummary[];
  /** What the main view shows: the Castle, the New Quest form, or a Quest's id. */
  current: 'castle' | 'new' | string;
  /** Quests waiting on an approval or a question. */
  waiting: ReadonlySet<string>;
  onCastle: () => void;
  onSelect: (id: string) => void;
  /** Takes a Quest's tab away on this device; it comes back when the Quest has new activity. */
  onPutAway: (id: string) => void;
  onNew: () => void;
  /** Moves a Quest tab to a new position among the Quest tabs, by drag-and-drop or Alt+Arrow. */
  onMove?: (id: string, index: number) => void;
  /** When the art pack is loaded: each Quest's party leader is drawn in its state instead of a status dot. */
  heroes?: { manifest: HeroManifest; states: Record<string, HeroState> };
}

const TAB =
  'group flex shrink-0 items-center gap-2 rounded-t-md border-x border-t px-3 py-1.5 text-sm whitespace-nowrap';
const ON = 'border-neutral-300 bg-white text-neutral-950 dark:border-neutral-700 dark:bg-neutral-950 dark:text-white';
const OFF =
  'border-transparent text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100';

/**
 * The Kingdom's tab strip: its Castle (home), one tab per active Quest, and New Quest. Each Quest tab shows its party
 * leader (docs/THEME.md) when the Heroes are loaded, or a status dot.
 */
export function QuestStrip({
  castleName,
  quests,
  current,
  waiting,
  onCastle,
  onSelect,
  onPutAway,
  onNew,
  onMove,
  heroes,
}: QuestStripProps) {
  const ids = quests.map((quest) => quest.id);
  return (
    <div
      role="tablist"
      aria-label={w('quests')}
      className="flex items-end gap-1 overflow-x-auto border-b border-neutral-300 bg-neutral-100 px-3 pt-1.5 dark:border-neutral-700 dark:bg-neutral-900"
    >
      <button
        type="button"
        role="tab"
        aria-selected={current === 'castle'}
        title={hint('castle')}
        onClick={onCastle}
        className={`${TAB} cb-display text-lg leading-none ${current === 'castle' ? ON : OFF}`}
      >
        {castleName}
      </button>
      {quests.map((quest) => {
        const selected = current === quest.id;
        const label = quest.label || quest.id;
        return (
          // The tab and its put-away button are siblings: a button can't hold another button.
          <div key={quest.id} data-quest={quest.id} className={`${TAB} max-w-60 pr-1.5 ${selected ? ON : OFF}`}>
            <button
              type="button"
              role="tab"
              aria-selected={selected}
              title={questTitle(quest)}
              onClick={() => onSelect(quest.id)}
              {...reorderHandlers(ids, quest.id, onMove)}
              className="flex min-w-0 items-center gap-2"
            >
              {heroes ? (
                <span className="-my-1.5 flex h-7 w-7 shrink-0 items-end justify-center">
                  <HeroSprite
                    manifest={heroes.manifest}
                    classId={heroes.manifest.leader}
                    state={heroes.states[quest.id] ?? 'resting'}
                    size={28}
                    decorative
                  />
                </span>
              ) : (
                <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[quest.status]}`} />
              )}
              <span className="truncate">{label}</span>
              {waiting.has(quest.id) && (
                <span
                  data-waiting
                  title="Needs you"
                  className="shrink-0 rounded-full bg-amber-500 px-1.5 text-xs font-bold leading-4 text-white"
                >
                  !
                </span>
              )}
            </button>
            <button
              type="button"
              aria-label={`Put away ${label}`}
              title={`Put away on this device (it comes back when the ${w('quest')} is active again)`}
              onClick={() => onPutAway(quest.id)}
              className="shrink-0 rounded px-1 text-neutral-400 hover:bg-neutral-300 hover:text-neutral-800 dark:hover:bg-neutral-700 dark:hover:text-neutral-100"
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        type="button"
        role="tab"
        aria-selected={current === 'new'}
        aria-label={w('newQuest')}
        title={hint('newQuest')}
        onClick={onNew}
        className={`${TAB} ${current === 'new' ? ON : OFF}`}
      >
        <span aria-hidden className="text-base leading-none">
          +
        </span>
        <span className="hidden sm:inline">{w('newQuest')}</span>
      </button>
    </div>
  );
}
