import { MAX_QUEST_TITLE } from '@crystal-bridge/protocol';
import { useContext, useEffect, useRef, useState } from 'react';
import type { BoardTab } from '../boards.js';
import { type HeroManifest, type HeroState, LeaderContext } from '../heroes.js';
import { projectName, questTitle } from '../quests.js';
import { reorderHandlers } from '../tabOrder.js';
import { keyHint } from '../hotkeys.js';
import { boardIcon } from '../theme/boardIcons.js';
import { Icon } from '../theme/icons.js';
import { hint, w } from '../theme/words.js';
import { HeroSprite } from './HeroSprite.js';
import type { SessionSummary } from './SessionList.js';
import { STATUS_DOT } from './SessionList.js';
import { Tip } from './Tip.js';

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
  /** Boards pinned on this device, drawn as icon-only tabs after the Castle (see `boardTabs`). */
  boards?: readonly BoardTab[];
  /** The Board shown now, whose tab is selected instead of the Castle's. */
  currentBoard?: string | undefined;
  onBoard?: (id: string) => void;
  /** Unpins a Board on this device; it stays on the Castle. */
  onUnpin?: (id: string) => void;
  /** Moves a pinned Board among the pinned Boards. */
  onMoveBoard?: (id: string, index: number) => void;
  /** Names a Quest by hand, for every device; its own titles no longer change it. Offered from the tab's right-click menu. */
  onRename?: (id: string, label: string) => void;
}

const TAB =
  'group flex shrink-0 items-center gap-2 rounded-t-md border-x border-t px-3 py-1.5 text-sm whitespace-nowrap';
const ON = 'border-neutral-300 bg-white text-neutral-950 dark:border-neutral-700 dark:bg-neutral-950 dark:text-white';
const OFF =
  'border-transparent text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100';

/**
 * The Kingdom's tab strip: its Castle (home), one tab per active Quest, and New Quest. Each Quest tab shows its party
 * leader (docs/THEME.md) when the Heroes are loaded, or a status dot, and the project under its title.
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
  boards = [],
  currentBoard,
  onBoard,
  onUnpin,
  onMoveBoard,
  onRename,
}: QuestStripProps) {
  const leaderOf = useContext(LeaderContext);
  const ids = quests.map((quest) => quest.id);
  const boardIds = boards.map((board) => board.id);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; tab: HTMLElement } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  return (
    <div
      role="tablist"
      aria-label={w('quests')}
      className="flex items-end gap-1 overflow-x-auto border-b border-neutral-300 bg-neutral-100 px-3 pt-1.5 dark:border-neutral-700 dark:bg-neutral-900"
    >
      <button
        type="button"
        role="tab"
        aria-selected={current === 'castle' && currentBoard === undefined}
        title={hint('castle')}
        onClick={onCastle}
        className={`${TAB} cb-display text-lg leading-none ${current === 'castle' && currentBoard === undefined ? ON : OFF}`}
      >
        {castleName}
      </button>
      {/* A menu whose Board is no longer pinned, unpinned from its page meanwhile, has nothing to act on. */}
      {onBoard && boards.length > 0 && (
        // Pinned like a browser's pinned tabs: icon only, before the Quests, no close button.
        <div data-pinned className="hidden items-end gap-1 md:flex">
          {boards.map((board) => (
            <BoardTabButton
              key={board.id}
              board={board}
              selected={currentBoard === board.id}
              onOpen={() => onBoard(board.id)}
              onMenu={onUnpin ? (x, y, tab) => setMenu({ id: board.id, x, y, tab }) : undefined}
              reorder={reorderHandlers(boardIds, board.id, onMoveBoard)}
            />
          ))}
        </div>
      )}
      {menu && onUnpin && boardIds.includes(menu.id) && (
        <TabMenu
          x={menu.x}
          y={menu.y}
          tab={menu.tab}
          onClose={() => setMenu(null)}
          items={[
            {
              label: 'Unpin from tab strip',
              onSelect: () => {
                setMenu(null);
                onUnpin(menu.id);
              },
            },
          ]}
        />
      )}
      {menu && onRename && ids.includes(menu.id) && (
        <TabMenu
          x={menu.x}
          y={menu.y}
          tab={menu.tab}
          onClose={() => setMenu(null)}
          items={[
            {
              label: 'Rename',
              onSelect: () => {
                setMenu(null);
                setRenaming(menu.id);
              },
            },
          ]}
        />
      )}
      {quests.map((quest) => {
        const selected = current === quest.id;
        const label = quest.label || quest.id;
        return (
          // The tab and its put-away button are siblings: a button can't hold another button.
          <div key={quest.id} data-quest={quest.id} className={`${TAB} max-w-60 pr-1.5 ${selected ? ON : OFF}`}>
            {renaming === quest.id && onRename ? (
              <RenameInput
                label={label}
                onDone={(name) => {
                  setRenaming(null);
                  if (name !== undefined && name !== label) onRename(quest.id, name);
                }}
              />
            ) : (
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                title={questTitle(quest)}
                onClick={() => onSelect(quest.id)}
                onContextMenu={
                  onRename
                    ? (event) => {
                        event.preventDefault();
                        setMenu({ id: quest.id, x: event.clientX, y: event.clientY, tab: event.currentTarget });
                      }
                    : undefined
                }
                {...reorderHandlers(ids, quest.id, onMove)}
                className="flex min-w-0 items-center gap-2"
              >
                {heroes ? (
                  <span className="-my-1.5 flex h-7 w-7 shrink-0 items-end justify-center">
                    <HeroSprite
                      manifest={heroes.manifest}
                      classId={leaderOf(quest.id) ?? heroes.manifest.leader}
                      state={heroes.states[quest.id] ?? 'resting'}
                      size={28}
                      decorative
                    />
                  </span>
                ) : (
                  <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[quest.status]}`} />
                )}
                <span className="flex min-w-0 flex-col items-start text-left leading-tight">
                  <span className="max-w-full truncate">{label}</span>
                  {/* Hidden from screen readers, which get it from the tab's title: the tab's name stays the label. */}
                  <span data-project aria-hidden className="max-w-full truncate font-mono text-xs text-neutral-500">
                    {projectName(quest.cwd)}
                  </span>
                </span>
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
            )}
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
        title={`${hint('newQuest')}${keyHint('new-quest')}`}
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

const PINNED =
  'relative flex shrink-0 items-center justify-center rounded-t-md border-x border-t px-2.5 py-1.5 h-[2.375rem]';

/** One pinned Board: its icon or first letter, a new-item count, and a warning dot when its Scout has stopped. */
function BoardTabButton({
  board,
  selected,
  onOpen,
  onMenu,
  reorder,
}: {
  board: BoardTab;
  selected: boolean;
  onOpen: () => void;
  onMenu: ((x: number, y: number, tab: HTMLElement) => void) | undefined;
  reorder: ReturnType<typeof reorderHandlers>;
}) {
  const icon = boardIcon(board.icon);
  const state = board.warn ?? (board.fresh > 0 ? `${board.fresh} new` : undefined);
  const tip = board.warn
    ? `${board.name} · ${board.warn}${board.reason ? `: ${board.reason}` : ''}`
    : state
      ? `${board.name} · ${state}`
      : board.name;
  return (
    // Beside the tab, fixed to the screen: the strip scrolls sideways and would clip a tooltip below it.
    <Tip text={tip} beside>
      <button
        type="button"
        role="tab"
        data-board={board.id}
        aria-selected={selected}
        aria-label={state ? `${board.name}, ${state}` : board.name}
        onClick={onOpen}
        onContextMenu={
          onMenu
            ? (event) => {
                event.preventDefault();
                onMenu(event.clientX, event.clientY, event.currentTarget);
              }
            : undefined
        }
        {...reorder}
        className={`${PINNED} ${selected ? ON : OFF}`}
      >
        {icon ? (
          <Icon name={icon} size={18} />
        ) : (
          <span
            aria-hidden
            className="flex h-[18px] w-[18px] items-center justify-center rounded bg-neutral-600 text-[11px] font-bold leading-none text-white dark:bg-neutral-300 dark:text-neutral-950"
          >
            {(Array.from(board.name)[0] ?? '?').toUpperCase()}
          </span>
        )}
        {board.warn ? (
          <span data-warn aria-hidden className="absolute right-1 top-1 h-2 w-2 rounded-full bg-amber-500" />
        ) : (
          board.fresh > 0 && (
            <span
              data-fresh
              aria-hidden
              className="absolute -right-0.5 top-0 min-w-4 rounded-full bg-amber-400 px-1 text-center text-[10px] font-bold leading-4 text-neutral-950"
            >
              {board.fresh > 99 ? '99+' : board.fresh}
            </span>
          )
        )}
      </button>
    </Tip>
  );
}

/**
 * A pinned tab's right-click menu, at the pointer. Escape closes it and returns focus to the tab; a click elsewhere or
 * focus moving out closes it too.
 */
function TabMenu({
  x,
  y,
  tab,
  onClose,
  items,
}: {
  x: number;
  y: number;
  tab: HTMLElement;
  onClose: () => void;
  items: readonly { label: string; onSelect: () => void }[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The caller passes a new function each draw; the listener and the first focus belong to the menu being open.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    ref.current?.querySelector('button')?.focus();
    const away = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) close.current();
    };
    window.addEventListener('pointerdown', away);
    return () => window.removeEventListener('pointerdown', away);
  }, []);
  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: x, top: y }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        close.current();
        tab.focus();
      }}
      onBlur={(event) => {
        if (!ref.current?.contains(event.relatedTarget as Node | null)) close.current();
      }}
      className="fixed z-50 min-w-44 rounded-md border border-neutral-300 bg-white py-1 text-sm shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          onClick={item.onSelect}
          className="block w-full px-3 py-1.5 text-left hover:bg-neutral-100 focus:bg-neutral-100 focus:outline-none dark:hover:bg-neutral-800 dark:focus:bg-neutral-800"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A Quest's name, being edited in place of its tab. Enter or leaving it saves; Escape keeps the old name. Gives the
 * new name trimmed, or nothing for an empty one or Escape.
 */
function RenameInput({ label, onDone }: { label: string; onDone: (name: string | undefined) => void }) {
  const [value, setValue] = useState(label);
  // Enter and the blur that follows the input going away would both finish it.
  const finished = useRef(false);
  const finish = (name: string | undefined) => {
    if (finished.current) return;
    finished.current = true;
    onDone(name?.trim() || undefined);
  };
  return (
    <input
      aria-label="New name"
      value={value}
      maxLength={MAX_QUEST_TITLE}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        // An Enter that confirms a composed character (CJK input) isn't the end of the name.
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) finish(value);
        if (event.key === 'Escape') finish(undefined);
      }}
      onBlur={() => finish(value)}
      className="w-48 min-w-0 rounded border border-neutral-300 bg-white px-1.5 py-0.5 text-sm text-neutral-950 dark:border-neutral-600 dark:bg-neutral-900 dark:text-white"
    />
  );
}
