import { type ReactNode, useEffect, useRef, useState } from 'react';
import { MAX_QUEST_ITEMS, MAX_QUEST_PROMPT } from '@crystal-bridge/protocol';
import type {
  BoardItem,
  BoardItemState,
  BoardQuest,
  PermissionMode,
  ScoutAction,
  ScoutManifest,
} from '@crystal-bridge/protocol';
import { actionsFor, linkFor, snoozeUntil } from '../boards.js';
import { SENDER_CLASSES, senderTone } from '../theme/boardTones.js';
import { sourceLine, w } from '../theme/words.js';
import { loadDefaultMode, MODES } from '../modes.js';
import { ThemedSelect } from './ThemedSelect.js';

/** The pieces a Board's views share: an item's buttons, its marks, the sender's avatar and the Quest composer. */

export const button =
  'rounded border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800';
/** The suggested action stands out from the item's other buttons. */
export const suggestedButton =
  'rounded border border-blue-600 bg-blue-600 px-2 py-0.5 text-xs font-bold text-white hover:bg-blue-700 disabled:opacity-50';

/** The classes an item's buttons wear: the suggested one, the rest, and the row that holds them. */
export interface ButtonLook {
  suggested: string;
  plain: string;
  row?: string;
}

const LOOK: ButtonLook = { suggested: suggestedButton, plain: button };

/** An extra row the synthesis step added: its id says so, and only the Kingdom sets the step's source word. */
function stepWrote(item: BoardItem): boolean {
  return item.id.startsWith('synthesis:') && item.summarySource !== undefined;
}

/** The tooltip for an item's row and title: where its rank and summary came from. */
export function itemNote(item: BoardItem): string | undefined {
  return sourceLine({ ...item, whole: stepWrote(item) });
}

/** The mark's words, when the step wrote a summary the Board shows, or the whole item. */
function markNote(item: BoardItem): string | undefined {
  if (item.summarySource === undefined || !(item.summary || stepWrote(item))) return undefined;
  return itemNote(item);
}

/**
 * A faint mark on an item whose summary, or the whole item, the synthesis step wrote: its words come from a model that
 * read untrusted items. The tooltip names the source.
 */
export function SourceMark({ item }: { item: BoardItem }) {
  const note = markNote(item);
  if (note === undefined) return null;
  return (
    <span role="img" aria-label={note} title={note} className="shrink-0 text-xs text-neutral-400 dark:text-neutral-500">
      ✦
    </span>
  );
}

/** The new mark: shown for the whole visit, though opening the Board has already marked the item seen. */
export function NewMark() {
  return (
    <span className="shrink-0 rounded bg-amber-400 px-1 text-[10px] font-bold uppercase text-neutral-950">New</span>
  );
}

/**
 * A button the Kingdom carries out. One that wants confirming asks first, in place, with no browser dialog. It stays
 * disabled while the Kingdom works, so a second press doesn't start a second Quest.
 */
export function KingdomButton({
  label,
  confirm,
  suggested,
  run,
  look = LOOK,
}: {
  label: string;
  confirm: boolean;
  suggested?: boolean;
  run: () => Promise<void>;
  look?: ButtonLook;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const go = () => {
    setAsking(false);
    setBusy(true);
    void run().finally(() => setBusy(false));
  };
  if (asking) {
    return (
      // Marked, so a row's tools stay shown while a confirm waits, though the pointer has left.
      <span data-asking className="flex gap-1">
        <button type="button" onClick={go} className={look.suggested}>
          {`Yes, ${label}`}
        </button>
        <button type="button" onClick={() => setAsking(false)} className={look.plain}>
          Cancel
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => (confirm ? setAsking(true) : go())}
      className={suggested ? look.suggested : look.plain}
      {...(suggested ? { title: 'Suggested' } : {})}
    >
      {busy ? `${label}…` : label}
    </button>
  );
}

/** An item's buttons. A link opens in a new tab; a quest or run goes to the Kingdom; the rest change its state. */
export function ItemActions({
  item,
  manifest,
  now,
  act,
  perform,
  look = LOOK,
}: {
  item: BoardItem;
  manifest: ScoutManifest;
  now: number;
  act: (ids: string[], state: BoardItemState, until?: number) => void;
  perform: (key: string, ids: string[]) => Promise<void>;
  /** The buttons' classes, for a surface of its own such as the Needs-you window. */
  look?: ButtonLook;
}) {
  const press = (action: ScoutAction) => {
    if (action.kind === 'snooze') act([item.id], 'snoozed', snoozeUntil(action.for, now));
    else if (action.kind === 'done') act([item.id], 'done');
    else if (action.kind === 'dismiss') act([item.id], 'dismissed');
  };
  return (
    <span className={look.row ?? 'flex shrink-0 flex-wrap gap-1'}>
      {actionsFor(item, manifest).map(({ key, action }) => {
        const suggested = item.suggested === key;
        if (action.kind === 'link') {
          const href = linkFor(action.url, item);
          return href ? (
            <a
              key={key}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className={suggested ? look.suggested : look.plain}
              {...(suggested ? { title: 'Suggested' } : {})}
            >
              {action.label}
            </a>
          ) : null;
        }
        if (action.kind === 'quest' || action.kind === 'run') {
          return (
            <KingdomButton
              key={key}
              label={action.label}
              confirm={action.kind === 'run' && Boolean(action.confirm)}
              suggested={suggested}
              run={() => perform(key, [item.id])}
              look={look}
            />
          );
        }
        return (
          <button
            key={key}
            type="button"
            onClick={() => press(action)}
            className={suggested ? look.suggested : look.plain}
            {...(suggested ? { title: 'Suggested' } : {})}
          >
            {action.label}
          </button>
        );
      })}
    </span>
  );
}

/** An item's title on hover, with where its rank and summary came from, which the row's own tooltip can't show there. */
export function titleNote(item: BoardItem): string {
  const note = itemNote(item);
  return note ? `${item.title}\n${note}` : item.title;
}

/** A name's first character, for an avatar or a Board without an icon; whole even when it's an emoji. */
export function monogram(name: string): string {
  return (Array.from(name.trim())[0] ?? '?').toUpperCase();
}

/** The Scout's first `quest` action with a plain folder: a Quest written on the Board starts in its folder and mode. */
function plainQuest(manifest: ScoutManifest): Extract<ScoutAction, { kind: 'quest' }> | undefined {
  return Object.values(manifest.actions).find(
    (action): action is Extract<ScoutAction, { kind: 'quest' }> =>
      action.kind === 'quest' && !action.project.includes('{{'),
  );
}

/** The opening words, which the user edits: what to do with the items, which follow as data. */
function defaultPrompt(count: number): string {
  return count === 1
    ? "Help me with this item. Say what you'd do and why, then wait for my go-ahead before changing anything."
    : `Work through these ${count} items with me, best first. For each, say what you'd do and why, then wait for my go-ahead before changing anything.`;
}

/**
 * Writes a Quest over Board items: the user's own prompt, the items as removable chips, the folder and the permission
 * mode. The Kingdom adds the items after the prompt as untrusted data, as a Scout's `quest` action does.
 */
export function QuestComposer({
  items,
  open,
  manifest,
  start,
  onClose,
}: {
  items: readonly BoardItem[];
  /** The Board's open items now. */
  open: readonly BoardItem[];
  manifest: ScoutManifest;
  start: (ask: BoardQuest) => Promise<void>;
  onClose: () => void;
}) {
  const [chosen, setChosen] = useState<readonly BoardItem[]>(items);
  const [prompt, setPrompt] = useState(() => defaultPrompt(items.length));
  const [project, setProject] = useState(() => plainQuest(manifest)?.project ?? '~');
  const [mode, setMode] = useState<PermissionMode>(() => plainQuest(manifest)?.mode ?? loadDefaultMode());
  const promptRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => promptRef.current?.focus(), []);
  // An item that left the open list (done elsewhere, gone) leaves the Quest too, so Start never asks for it.
  const openIds = new Set(open.map((item) => item.id));
  const shown = chosen.filter((item) => openIds.has(item.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await start({ ids: shown.map((item) => item.id), prompt, project: project.trim() || '~', mode });
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      aria-label={`${w('newQuest')} from this ${w('board')}`}
      onSubmit={(event) => {
        event.preventDefault();
        void go();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
      className="space-y-2 rounded-md border border-blue-300 bg-blue-50/50 p-2.5 dark:border-blue-800 dark:bg-blue-950/30"
    >
      <ul aria-label="Items it works on" className="flex flex-wrap gap-1">
        {shown.map((item) => (
          <li
            key={item.id}
            className="flex max-w-full items-center gap-1 rounded-full bg-white py-0.5 pl-2 pr-1 text-xs ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-700"
          >
            <span className="truncate">{item.title}</span>
            <button
              type="button"
              aria-label={`Leave out ${item.title}`}
              onClick={() => setChosen((all) => all.filter((one) => one.id !== item.id))}
              className="rounded-full px-1 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900 dark:hover:bg-neutral-700 dark:hover:text-white"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <label className="block text-xs text-neutral-500">
        Prompt
        <textarea
          ref={promptRef}
          value={prompt}
          maxLength={MAX_QUEST_PROMPT}
          onChange={(event) => setPrompt(event.target.value)}
          rows={4}
          className="mt-0.5 block w-full rounded border border-neutral-300 bg-white p-1.5 text-sm text-neutral-950 dark:border-neutral-700 dark:bg-neutral-950 dark:text-white"
        />
      </label>
      <p className="text-xs text-neutral-500">
        The items follow your prompt as data, marked untrusted: the {w('quest')} treats their text as something to act
        on, never as instructions.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 text-xs text-neutral-500">
          Folder
          <input
            value={project}
            onChange={(event) => setProject(event.target.value)}
            className="mt-0.5 block w-full rounded border border-neutral-300 bg-white px-1.5 py-1 font-mono text-xs text-neutral-950 dark:border-neutral-700 dark:bg-neutral-950 dark:text-white"
          />
        </label>
        <ThemedSelect
          label="Permission mode"
          icon="mode"
          size="sm"
          title={`Permission mode: how much the ${w('quest')} may do without asking`}
          value={mode}
          options={MODES}
          onChange={(value) => setMode(value as PermissionMode)}
        />
      </div>
      {error && (
        <p role="alert" className="whitespace-pre-wrap text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-1">
        <button type="button" onClick={onClose} className={button}>
          Cancel
        </button>
        <button type="submit" disabled={busy || shown.length === 0 || prompt.trim() === ''} className={suggestedButton}>
          {busy ? 'Starting…' : `Start ${w('quest')}`}
        </button>
      </div>
    </form>
  );
}

/**
 * Where a row keeps its buttons: out of the way until hover or keyboard focus, as a mail client's row tools, and while
 * a confirm waits. Hidden buttons take no clicks. A touch screen has no hover: there they sit at the row's end, shown.
 * The row is a `group` and `relative`.
 */
export const ROW_TOOLS =
  'has-[[data-asking]]:pointer-events-auto has-[[data-asking]]:opacity-100 pointer-events-none absolute inset-y-1 right-0 flex items-center rounded-md bg-white px-1.5 opacity-0 shadow-md ring-1 ring-neutral-200 transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 dark:bg-neutral-900 dark:ring-neutral-700 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:static [@media(hover:none)]:self-center [@media(hover:none)]:opacity-100 [@media(hover:none)]:shadow-none [@media(hover:none)]:ring-0';

/** A sender's round monogram in their colour, keyed on something that names them for good. */
export function Avatar({
  who,
  whoKey,
  small = false,
  named = false,
}: {
  who: string;
  whoKey?: string;
  small?: boolean;
  /** Says who in its tooltip, where nothing beside it does. */
  named?: boolean;
}) {
  const tone = senderTone(whoKey ?? who);
  return (
    <span
      data-avatar
      data-tone={tone}
      {...(named ? { title: who } : { 'aria-hidden': true })}
      className={`flex shrink-0 items-center justify-center rounded-full font-bold ${small ? 'h-[22px] w-[22px] text-[11px]' : 'mt-0.5 h-8 w-8 text-sm'} ${SENDER_CLASSES[tone].avatar}`}
    >
      {monogram(who)}
    </span>
  );
}

/** The most one Quest written on the Board takes, best first, and how its button names them. */
export function questBatch(items: readonly BoardItem[]): { best: BoardItem[]; label: string } {
  const unranked = Number.MAX_SAFE_INTEGER;
  const sorted = [...items].sort((a, b) => (a.rank ?? unranked) - (b.rank ?? unranked));
  return {
    best: sorted.slice(0, MAX_QUEST_ITEMS),
    label: sorted.length > MAX_QUEST_ITEMS ? `the best ${MAX_QUEST_ITEMS}` : `all ${sorted.length}`,
  };
}

/** The button that opens the composer on a batch of items: "Quest on all 4". */
export function QuestAllButton({
  label,
  what,
  onPress,
  className = suggestedButton,
}: {
  label: string;
  /** What the items are, for the tooltip. */
  what: string;
  onPress: () => void;
  className?: string;
}): ReactNode {
  return (
    <button
      type="button"
      aria-label={`Start a ${w('quest')} on ${label}`}
      title={`Write a ${w('quest')} that works through ${what}, best first, up to ${MAX_QUEST_ITEMS}`}
      onClick={onPress}
      className={className}
    >
      {`${w('quest')} on ${label}`}
    </button>
  );
}
