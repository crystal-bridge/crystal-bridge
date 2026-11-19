import { type ReactNode, useEffect, useRef, useState } from 'react';
import { MAX_QUEST_ITEMS, MAX_QUEST_PROMPT } from '@crystal-bridge/protocol';
import type {
  Board,
  BoardQuest,
  PermissionMode,
  BoardItem,
  BoardItemState,
  ListedScout,
  ScoutAction,
  ScoutManifest,
  ScoutRun,
} from '@crystal-bridge/protocol';
import {
  actionsFor,
  batchesFor,
  boardCounts,
  boardSections,
  lastSynthesis,
  linkFor,
  recommendations,
  rowView,
  settled,
  snoozeUntil,
  tableColumns,
} from '../boards.js';
import { duration, goldText, shortWhen } from '../format.js';
import { boardIcon } from '../theme/boardIcons.js';
import { actionTone, CHIP_CLASSES, SENDER_CLASSES, senderTone, TILE_CLASSES, TILE_TONES } from '../theme/boardTones.js';
import { Icon } from '../theme/icons.js';
import { hint, scoutReturnLine, sourceLine, w } from '../theme/words.js';
import { Gold } from './Gold.js';
import { ThemedSelect } from './ThemedSelect.js';
import { loadDefaultMode, MODES } from '../modes.js';
import { ago, Folded, HOME_PAGE } from './HomeParts.js';

export interface BoardPageProps {
  /** The Kingdom's name, for the way back. */
  kingdom: string;
  /** The Scout as the hub lists it; undefined until the list loads, or when the Kingdom no longer has it. */
  scout: ListedScout | undefined;
  board: Board | null;
  /** The hub has no such Scout on this Kingdom. */
  missing: boolean;
  /** Why the Board didn't load, when it didn't. */
  failed?: string;
  now: number;
  /** Changes items' state on the hub; rejects with the hub's reason. */
  onChange: (ids: string[], state: BoardItemState, until?: number) => Promise<void>;
  /** Asks the Kingdom to run the Scout now; rejects with the hub's reason. */
  onRunNow: () => Promise<void>;
  /** Has the Kingdom carry out a `quest` or `run` action on items; rejects with the reason it didn't. */
  onAct: (action: string, ids: string[]) => Promise<{ session?: string }>;
  /** Starts one Quest over Board items with the user's own prompt; rejects with the reason it didn't. */
  onQuest?: (ask: BoardQuest) => Promise<{ session?: string }>;
  /** Opens the Quest an action started. */
  onOpenQuest: (session: string) => void;
  onBack: () => void;
  /** Whether this Board has a pinned tab on this device; without `onPin`, no pin button. */
  pinned?: boolean;
  onPin?: (pinned: boolean) => void;
}

const button =
  'rounded border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800';
/** The suggested action stands out from the item's other buttons. */
const suggestedButton =
  'rounded border border-blue-600 bg-blue-600 px-2 py-0.5 text-xs font-bold text-white hover:bg-blue-700 disabled:opacity-50';

const OUTCOME_DOT: Record<string, string> = {
  succeeded: 'bg-green-500',
  failed: 'bg-red-500',
  'timed-out': 'bg-red-500',
  skipped: 'bg-neutral-400',
};

/** A field's value as a cell or a line shows it. */
function shown(value: string | number | boolean | null | undefined): string {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  return value === null || value === undefined ? '' : String(value);
}

/** An extra row the synthesis step added: its id says so, and only the Kingdom sets the step's source word. */
function stepWrote(item: BoardItem): boolean {
  return item.id.startsWith('synthesis:') && item.summarySource !== undefined;
}

/** The tooltip for an item's row and title: where its rank and summary came from. */
function itemNote(item: BoardItem): string | undefined {
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
function SourceMark({ item }: { item: BoardItem }) {
  const note = markNote(item);
  if (note === undefined) return null;
  return (
    <span role="img" aria-label={note} title={note} className="shrink-0 text-xs text-neutral-400 dark:text-neutral-500">
      ✦
    </span>
  );
}

/** The new mark: shown for the whole visit, though opening the Board has already marked the item seen. */
function NewMark() {
  return (
    <span className="shrink-0 rounded bg-amber-400 px-1 text-[10px] font-bold uppercase text-neutral-950">New</span>
  );
}

/**
 * A button the Kingdom carries out. One that wants confirming asks first, in place, with no browser dialog. It stays
 * disabled while the Kingdom works, so a second press doesn't start a second Quest.
 */
function KingdomButton({
  label,
  confirm,
  suggested,
  run,
}: {
  label: string;
  confirm: boolean;
  suggested?: boolean;
  run: () => Promise<void>;
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
        <button type="button" onClick={go} className={suggestedButton}>
          {`Yes, ${label}`}
        </button>
        <button type="button" onClick={() => setAsking(false)} className={button}>
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
      className={suggested ? suggestedButton : button}
      {...(suggested ? { title: 'Suggested' } : {})}
    >
      {busy ? `${label}…` : label}
    </button>
  );
}

/** An item's buttons. A link opens in a new tab; a quest or run goes to the Kingdom; the rest change its state. */
function ItemActions({
  item,
  manifest,
  now,
  act,
  perform,
}: {
  item: BoardItem;
  manifest: ScoutManifest;
  now: number;
  act: (ids: string[], state: BoardItemState, until?: number) => void;
  perform: (key: string, ids: string[]) => Promise<void>;
}) {
  const press = (action: ScoutAction) => {
    if (action.kind === 'snooze') act([item.id], 'snoozed', snoozeUntil(action.for, now));
    else if (action.kind === 'done') act([item.id], 'done');
    else if (action.kind === 'dismiss') act([item.id], 'dismissed');
  };
  return (
    <span className="flex shrink-0 flex-wrap gap-1">
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
              className={suggested ? suggestedButton : button}
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
            />
          );
        }
        return (
          <button
            key={key}
            type="button"
            onClick={() => press(action)}
            className={suggested ? suggestedButton : button}
            {...(suggested ? { title: 'Suggested' } : {})}
          >
            {action.label}
          </button>
        );
      })}
    </span>
  );
}

/** One button per `run` action that takes several items, for the items in view that offer it. */
function BatchActions({
  items,
  manifest,
  perform,
}: {
  items: readonly BoardItem[];
  manifest: ScoutManifest;
  perform: (key: string, ids: string[]) => Promise<void>;
}) {
  const batches = batchesFor(items, manifest);
  if (batches.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {batches.map(({ key, action, ids }) => (
        <KingdomButton
          key={key}
          label={`${action.label} all ${ids.length}`}
          confirm={Boolean(action.confirm)}
          run={() => perform(key, ids)}
        />
      ))}
    </span>
  );
}

/** An item's title on hover, with where its rank and summary came from, which the row's own tooltip can't show there. */
function titleNote(item: BoardItem): string {
  const note = itemNote(item);
  return note ? `${item.title}\n${note}` : item.title;
}

function ItemText({ item, marked }: { item: BoardItem; marked: boolean }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="flex items-center gap-2">
        {marked && <NewMark />}
        <span className="truncate font-medium" title={titleNote(item)}>
          {item.title}
        </span>
        <SourceMark item={item} />
      </span>
      {item.subtitle && <span className="block truncate text-xs text-neutral-500">{item.subtitle}</span>}
      {item.summary && (
        <span className="line-clamp-2 text-xs text-neutral-600 dark:text-neutral-300" title={item.summary}>
          {item.summary}
        </span>
      )}
    </span>
  );
}

/** A folded item: what became of it, and a way to bring it back while the collector still lists it. */
function PastRow({
  item,
  note,
  act,
}: {
  item: BoardItem;
  note: string;
  act?: (ids: string[], state: BoardItemState) => void;
}) {
  return (
    <li className="flex items-center gap-3 py-1.5">
      <ItemText item={item} marked={false} />
      <span className="shrink-0 text-xs text-neutral-500">{note}</span>
      {act && (
        <button type="button" onClick={() => act([item.id], 'new')} className={button}>
          Bring back
        </button>
      )}
    </li>
  );
}

function RunRow({ run, now }: { run: ScoutRun; now: number }) {
  return (
    <li className="py-1.5 text-sm">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${OUTCOME_DOT[run.outcome] ?? 'bg-neutral-400'}`} />
        <span className="font-medium">{run.outcome}</span>
        <span className="text-neutral-500">
          {run.trigger} · {ago(run.startedAt, now)} ago
          {run.finishedAt !== undefined && ` · ${duration(run.finishedAt - run.startedAt)}`}
          {run.items !== undefined && ` · ${run.items} ${run.items === 1 ? 'item' : 'items'}`}
          {run.reason && run.outcome !== 'succeeded' && ` · ${run.reason}`}
        </span>
        {run.costUsd !== undefined && (
          <span className="ml-auto text-xs">
            <Gold usd={run.costUsd} compact />
          </span>
        )}
      </div>
      {/* A run that brought its list but skipped a step, such as synthesis, says why where it can't be missed. */}
      {run.reason && run.outcome === 'succeeded' && (
        <p className="mt-0.5 pl-4 text-xs text-amber-700 dark:text-amber-400">{run.reason}</p>
      )}
      {run.stderr && (
        <details className="mt-1 pl-4">
          <summary className="cursor-pointer text-xs text-neutral-500">stderr</summary>
          <pre className="mt-1 max-h-60 overflow-auto rounded bg-neutral-100 p-2 text-xs dark:bg-neutral-900">
            {run.stderr}
          </pre>
        </details>
      )}
    </li>
  );
}

/** A name's first character, for an avatar or a Board without an icon; whole even when it's an emoji. */
function monogram(name: string): string {
  return (Array.from(name.trim())[0] ?? '?').toUpperCase();
}

/**
 * A `list` row drawn like a mail client's: who it's from, when, the title with a line of preview, bold while unread. The
 * buttons show on hover, keyboard focus or touch, and while a confirm waits; at rest a tag names the suggested action,
 * so the list isn't a wall of buttons. Without `show`, the title and subtitle fill the lines.
 */
function MailRow({
  item,
  marked,
  show,
  now,
  suggestion,
  actions,
}: {
  item: BoardItem;
  marked: boolean;
  show: ScoutManifest['show'];
  now: number;
  /** The suggested action's label, tagged on the row. */
  suggestion: { key: string; label: string; kind: string } | undefined;
  actions: ReactNode;
}) {
  const view = rowView(item, show);
  const tone = view.whoKey !== undefined ? senderTone(view.whoKey) : undefined;
  // Bold follows unread where the Scout says what that is; else what's new on this visit stands out.
  const strong = show?.unread !== undefined ? view.unread : marked;
  return (
    <li
      className="group relative flex items-start gap-3 py-2 pl-1 pr-1 hover:bg-neutral-50 dark:hover:bg-neutral-900"
      data-unread={view.unread}
      title={itemNote(item)}
    >
      {view.who !== undefined && (
        <span
          data-avatar
          aria-hidden
          data-tone={tone}
          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${SENDER_CLASSES[tone!].avatar}`}
        >
          {monogram(view.who)}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          {/* Where the Scout says what unread is, a dot says it (and words, for a screen reader); else the New mark. */}
          {show?.unread !== undefined
            ? view.unread && (
                <span className="h-2 w-2 shrink-0 self-center rounded-full bg-blue-500">
                  <span className="sr-only">Unread</span>
                </span>
              )
            : marked && <NewMark />}
          <span
            {...(tone ? { 'data-tone': tone } : {})}
            className={`truncate ${strong ? 'font-semibold' : ''} ${tone ? SENDER_CLASSES[tone].text : ''}`}
            title={view.who ?? titleNote(item)}
          >
            {view.who ?? item.title}
          </span>
          <SourceMark item={item} />
          {suggestion && (
            <span
              aria-hidden
              data-suggestion
              data-tone={actionTone(suggestion.key, suggestion.kind)}
              className={`ml-auto shrink-0 rounded-full px-2 text-[11px] font-semibold leading-4 ring-1 ${CHIP_CLASSES[actionTone(suggestion.key, suggestion.kind)]}`}
            >
              {suggestion.label}
            </span>
          )}
          {view.when !== undefined && (
            <span
              className={`${suggestion ? '' : 'ml-auto '}shrink-0 text-xs tabular-nums ${strong ? 'font-semibold' : 'text-neutral-500'}`}
              title={new Date(view.when).toLocaleString()}
            >
              {shortWhen(view.when, now)}
            </span>
          )}
        </span>
        {view.who !== undefined ? (
          <span className="block truncate text-sm">
            <span
              className={strong ? 'font-semibold' : 'text-neutral-700 dark:text-neutral-300'}
              title={titleNote(item)}
            >
              {item.title}
            </span>
            {(view.preview ?? item.subtitle) && (
              <span className="text-neutral-500">{` · ${view.preview ?? item.subtitle}`}</span>
            )}
          </span>
        ) : (
          item.subtitle && <span className="block truncate text-xs text-neutral-500">{item.subtitle}</span>
        )}
        {item.summary && (
          <span className="line-clamp-2 text-xs text-neutral-600 dark:text-neutral-300" title={item.summary}>
            {item.summary}
          </span>
        )}
      </span>
      {/* Out of the way until hover or keyboard focus, as a mail client's row tools: the date and the suggestion show at
          rest, and the Counsel pane keeps a button for each suggestion. Hidden buttons take no clicks. */}
      {/* A touch screen has no hover: there the buttons sit at the row's end, always shown. */}
      <span
        data-row-tools
        className="has-[[data-asking]]:pointer-events-auto has-[[data-asking]]:opacity-100 pointer-events-none absolute inset-y-1 right-0 flex items-center rounded-md bg-white px-1.5 opacity-0 shadow-md ring-1 ring-neutral-200 transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 dark:bg-neutral-900 dark:ring-neutral-700 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:static [@media(hover:none)]:self-center [@media(hover:none)]:opacity-100 [@media(hover:none)]:shadow-none [@media(hover:none)]:ring-0"
      >
        {actions}
      </span>
    </li>
  );
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
function QuestComposer({
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
 * Counsel: what the synthesis step (or the collector) suggests doing, gathered under each action, best first, with the
 * action's button on each item and one for the group where the action takes several.
 */
function Counsel({
  open,
  manifest,
  perform,
  act,
  now,
  start,
}: {
  open: readonly BoardItem[];
  manifest: ScoutManifest;
  perform: (key: string, ids: string[]) => Promise<void>;
  act: (ids: string[], state: BoardItemState, until?: number) => void;
  now: number;
  /** Starts a Quest the user wrote; without it, Counsel offers none. */
  start?: (ask: BoardQuest) => Promise<void>;
}) {
  const groups = recommendations(open, manifest);
  const [composing, setComposing] = useState<BoardItem[] | null>(null);
  // Best first, as many as one Quest holds.
  const suggested = groups
    .flatMap((group) => group.items)
    .sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER));
  const best = suggested.slice(0, MAX_QUEST_ITEMS);
  const allLabel = suggested.length > MAX_QUEST_ITEMS ? `the best ${MAX_QUEST_ITEMS}` : `all ${suggested.length}`;
  return (
    <section
      aria-label={w('counsel')}
      className="space-y-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="cb-display text-2xl leading-none" title={hint('counsel')}>
          {w('counsel')}
        </h2>
        {start && suggested.length > 0 && !composing && (
          <button
            type="button"
            aria-label={`Start a ${w('quest')} on ${allLabel}`}
            title={`Write a ${w('quest')} that works through the suggestions here, best first, up to ${MAX_QUEST_ITEMS}`}
            onClick={() => setComposing(best)}
            className={suggestedButton}
          >
            {`${w('quest')} on ${allLabel}`}
          </button>
        )}
      </div>
      {start && composing && (
        <QuestComposer
          key={composing.map((item) => item.id).join(' ')}
          items={composing}
          open={open}
          manifest={manifest}
          start={start}
          onClose={() => setComposing(null)}
        />
      )}
      {groups.length === 0 ? (
        <p className="text-sm text-neutral-500">
          {manifest.synthesize
            ? `Nothing suggested yet. Run now asks ${w('synthesis')} to rank the list and suggest what to do.`
            : `This ${w('scout')} suggests nothing yet.`}
        </p>
      ) : (
        groups.map(({ key, action, items }) => (
          <div key={key} role="group" aria-label={action.label} className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <h3 className="flex items-center gap-1.5 text-sm">
                <span
                  data-chip
                  data-tone={actionTone(key, action.kind)}
                  className={`rounded-full px-2.5 py-0.5 text-xs font-bold ring-1 ${CHIP_CLASSES[actionTone(key, action.kind)]}`}
                >
                  {action.label}
                </span>
                <span className="text-xs text-neutral-500">{items.length}</span>
              </h3>
              {action.kind === 'run' && action.batch && items.length > 1 && (
                <KingdomButton
                  label={`${action.label} all ${items.length}`}
                  confirm={Boolean(action.confirm)}
                  run={() =>
                    perform(
                      key,
                      items.map((item) => item.id),
                    )
                  }
                />
              )}
            </div>
            <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {items.map((item) => (
                <li key={item.id} className="flex items-start gap-2 py-1.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium" title={titleNote(item)}>
                      {item.title}
                    </span>
                    {rowView(item, manifest.show).who !== undefined && (
                      <span className="block truncate text-xs text-neutral-500">
                        {rowView(item, manifest.show).who}
                      </span>
                    )}
                    {item.summary && (
                      <span
                        className="line-clamp-2 text-xs text-neutral-600 dark:text-neutral-300"
                        title={item.summary}
                      >
                        {item.summary}
                      </span>
                    )}
                  </span>
                  {start && (
                    <button
                      type="button"
                      aria-label={`Start a ${w('quest')} on ${item.title}`}
                      title={`Write a ${w('quest')} about this item`}
                      // A draft open above stays until it's started or cancelled.
                      disabled={composing !== null}
                      onClick={() => setComposing([item])}
                      className={button}
                    >
                      {w('quest')}
                    </button>
                  )}
                  <ItemActions
                    item={{ ...item, actions: [key] }}
                    manifest={manifest}
                    now={now}
                    act={act}
                    perform={perform}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

/**
 * A Scout's Board (docs/SCOUTS.md): what it found, drawn from data alone in one of three views, with a button for each
 * thing to do about an item. Opening it marks what's new as seen; the mark stays until the Board is left.
 */
export function BoardPage({
  kingdom,
  scout,
  board,
  missing,
  failed,
  now,
  onChange,
  onRunNow,
  onAct,
  onOpenQuest,
  onBack,
  pinned = false,
  onPin,
  onQuest,
}: BoardPageProps) {
  const [marked, setMarked] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // Each item marked seen once while it stays new, so a slow answer doesn't send it again; once it's anything else, it
  // may come back as new and be marked again.
  const asked = useRef(new Set<string>());

  const act = (ids: string[], state: BoardItemState, until?: number) => {
    setError(null);
    (until === undefined ? onChange(ids, state) : onChange(ids, state, until)).catch((failure: unknown) =>
      setError(failure instanceof Error ? failure.message : String(failure)),
    );
  };

  /** A quest or run action, carried out by the Kingdom; a Quest it starts opens. */
  const perform = async (key: string, ids: string[]): Promise<void> => {
    setError(null);
    try {
      const { session } = await onAct(key, ids);
      if (session) onOpenQuest(session);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  useEffect(() => {
    if (!board) return;
    // As the Board shows them: a snooze that has run out is new.
    const items = board.items.map((item) => settled(item, now));
    for (const item of items) if (item.state !== 'new') asked.current.delete(item.id);
    const fresh = items.filter(
      (item) => item.state === 'new' && item.goneAt === undefined && !asked.current.has(item.id),
    );
    if (fresh.length === 0) return;
    for (const item of fresh) asked.current.add(item.id);
    setMarked((known) => new Set([...known, ...fresh.map((item) => item.id)]));
    onChange(
      fresh.map((item) => item.id),
      'seen',
    ).catch(() => {});
  }, [board, now, onChange]);

  async function runNow(): Promise<void> {
    setError(null);
    setRunning(true);
    try {
      await onRunNow();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setRunning(false);
    }
  }

  const back = (
    <button
      type="button"
      onClick={onBack}
      className="text-sm text-neutral-500 hover:text-neutral-950 dark:hover:text-white"
    >
      {`← Back to ${kingdom}`}
    </button>
  );

  if (missing || board === null) {
    return (
      <div className={`${HOME_PAGE} space-y-3 px-3 py-6`}>
        {back}
        {missing ? (
          <p className="text-sm text-neutral-500">{`No such ${w('scout')} on ${kingdom}. It may have been removed from its folder.`}</p>
        ) : failed ? (
          <p role="alert" className="whitespace-pre-wrap text-sm text-red-600 dark:text-red-400">
            {`This ${w('board')} didn't load: ${failed}`}
          </p>
        ) : (
          <p className="text-sm text-neutral-500">Loading…</p>
        )}
      </div>
    );
  }

  const manifest = scout?.manifest;
  const name = manifest?.name ?? scout?.id ?? board?.scout ?? '';
  const items = board?.items ?? [];
  const view = manifest?.view ?? 'list';
  // A list with a time field reads newest first, like an inbox; the ranking moves to the Counsel pane.
  const sections = boardSections(items, now, view === 'list' ? manifest?.show?.when : undefined);
  const lastRun = board?.runs[0] ?? scout?.lastRun;
  const isMarked = (item: BoardItem) => item.state === 'new' || marked.has(item.id);
  // A checklist keeps what's ticked in place; the other views fold it away with what was dismissed.
  const ticked = view === 'checklist' ? sections.setAside.filter((item) => item.state === 'done') : [];
  const setAside = view === 'checklist' ? sections.setAside.filter((item) => item.state !== 'done') : sections.setAside;
  const openCount = sections.open.reduce((total, group) => total + group.items.length, 0);
  const openItems = sections.open.flatMap((group) => group.items);
  const counts = boardCounts(openItems, manifest);
  const augury = lastSynthesis(board.runs, openItems);
  const icon = boardIcon(manifest?.icon);
  // Counsel has a place when something suggests: the synthesis step, or a collector that already has.
  const counsel = Boolean(manifest && (manifest.synthesize || counts.suggested > 0));
  const tiles: { label: string; value: string; hint?: string }[] = [
    { label: 'Open', value: String(counts.open) },
    { label: 'New', value: String(openItems.filter(isMarked).length), hint: 'new since anyone last looked' },
    ...(manifest?.synthesize || counts.suggested > 0
      ? [{ label: 'Suggested', value: String(counts.suggested), hint: 'items with a suggested action' }]
      : []),
    ...counts.declared.map(({ label, count }) => ({ label, value: String(count) })),
    ...(manifest?.synthesize
      ? [
          {
            label: w('synthesis').replace(/^\w/, (first) => first.toUpperCase()),
            value: !augury
              ? 'not yet'
              : 'earlier' in augury
                ? 'earlier'
                : `${ago(augury.at, now)} ago · ${goldText(augury.costUsd)}`,
            hint: `when ${hint('synthesis')} last ranked the list, and what it cost`,
          },
        ]
      : []),
  ];

  const mailRow = (item: BoardItem) => (
    <MailRow
      key={item.id}
      item={item}
      marked={isMarked(item)}
      show={manifest?.show}
      now={now}
      suggestion={(() => {
        const found =
          manifest && item.suggested ? actionsFor(item, manifest).find(({ key }) => key === item.suggested) : undefined;
        return found ? { key: found.key, label: found.action.label, kind: found.action.kind } : undefined;
      })()}
      actions={manifest && <ItemActions item={item} manifest={manifest} now={now} act={act} perform={perform} />}
    />
  );

  const row = (item: BoardItem) => (
    <li key={item.id} className="flex items-center gap-3 py-1.5" title={itemNote(item)}>
      {view === 'checklist' && (
        <input
          type="checkbox"
          aria-label={item.title}
          checked={item.state === 'done'}
          onChange={(event) => act([item.id], event.target.checked ? 'done' : 'new')}
          className="h-4 w-4 shrink-0"
        />
      )}
      <span className={`flex min-w-0 flex-1 ${item.state === 'done' ? 'text-neutral-500 line-through' : ''}`}>
        <ItemText item={item} marked={item.state !== 'done' && isMarked(item)} />
      </span>
      {manifest && <ItemActions item={item} manifest={manifest} now={now} act={act} perform={perform} />}
    </li>
  );

  const columns = view === 'table' ? tableColumns(sections.open.flatMap((group) => group.items)) : [];
  const table = (
    <>
      {manifest && (
        <BatchActions items={sections.open.flatMap((group) => group.items)} manifest={manifest} perform={perform} />
      )}
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-neutral-500">
          <tr>
            <th className="py-1 pr-3 font-medium">Item</th>
            {columns.map((column) => (
              <th key={column} className="py-1 pr-3 font-medium">
                {column}
              </th>
            ))}
            <th className="py-1" />
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {sections.open.flatMap((group) =>
            group.items.map((item) => (
              <tr key={item.id} title={itemNote(item)}>
                <td className="py-1.5 pr-3">
                  <span className="flex items-center gap-2">
                    {isMarked(item) && <NewMark />}
                    <span className="font-medium" title={titleNote(item)}>
                      {item.title}
                    </span>
                    <SourceMark item={item} />
                  </span>
                  {item.subtitle && <span className="block text-xs text-neutral-500">{item.subtitle}</span>}
                  {item.summary && (
                    <span className="line-clamp-2 text-xs text-neutral-600 dark:text-neutral-300" title={item.summary}>
                      {item.summary}
                    </span>
                  )}
                </td>
                {columns.map((column) => (
                  <td key={column} className="py-1.5 pr-3">
                    {shown(item.fields?.[column])}
                  </td>
                ))}
                <td className="py-1.5">
                  {manifest && <ItemActions item={item} manifest={manifest} now={now} act={act} perform={perform} />}
                </td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </>
  );

  return (
    <div className="h-full overflow-y-auto">
      <p className="px-3 py-6 text-sm text-neutral-500 md:hidden">{`${w('boards')} are on wider screens for now.`}</p>
      {/* A desktop page for now, like the Summoning Circle: a phone's actions need their own design. */}
      <div className={`${HOME_PAGE} hidden space-y-5 py-6 md:block`}>
        <div className="px-3">{back}</div>
        <header
          aria-label="Summary"
          role="region"
          className="mx-3 space-y-3 rounded-lg border border-neutral-200 bg-linear-to-r from-sky-50 via-white to-violet-50 p-4 dark:border-neutral-800 dark:from-sky-950/50 dark:via-neutral-900 dark:to-violet-950/50"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <span
                aria-hidden
                className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-sky-100 text-sky-700 shadow-sm ring-1 ring-sky-200 dark:bg-sky-900 dark:text-sky-200 dark:ring-sky-700"
              >
                {icon ? <Icon name={icon} size={22} /> : <span className="text-lg font-bold">{monogram(name)}</span>}
              </span>
              <div className="min-w-0">
                <h1 className="cb-display text-4xl leading-none" title={hint('board')}>
                  {name}
                </h1>
                <p className="text-sm text-neutral-500">
                  <span title={hint('scout')}>{w('scout')}</span> on {kingdom}
                  {manifest && (
                    <span title="its schedule, in its time zone">
                      {' '}
                      · {manifest.schedule.cron} ({manifest.schedule.timezone})
                    </span>
                  )}
                  {scout?.nextRunAt !== undefined && !scout.paused && (
                    <span> · next {new Date(scout.nextRunAt).toLocaleString()}</span>
                  )}
                </p>
                {lastRun?.outcome === 'succeeded' && lastRun.items !== undefined && (
                  <p className="text-sm" title={scoutReturnLine(lastRun.items).plain}>
                    {scoutReturnLine(lastRun.items).themed}
                    <span className="text-neutral-500"> {ago(lastRun.finishedAt ?? lastRun.startedAt, now)} ago</span>
                  </p>
                )}
              </div>
            </div>
            <span className="flex items-center gap-2">
              {onPin && (
                <button
                  type="button"
                  onClick={() => onPin(!pinned)}
                  title={
                    pinned
                      ? 'Take its tab out of the tab strip on this device'
                      : 'Give it a tab in the tab strip on this device'
                  }
                  className="rounded-md border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
                >
                  {pinned ? 'Unpin from tab strip' : 'Pin to tab strip'}
                </button>
              )}
              {manifest && (
                <button
                  type="button"
                  disabled={running}
                  title={
                    manifest.synthesize?.when === 'now'
                      ? `Collects now, then asks ${hint('synthesis')} to rank the list if it changed since the last press, which may spend plan usage`
                      : undefined
                  }
                  onClick={() => void runNow()}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {running ? 'Asking…' : 'Run now'}
                </button>
              )}
            </span>
          </div>
          <dl className="grid grid-cols-[repeat(auto-fit,minmax(6.5rem,1fr))] gap-2">
            {tiles.map((tile, index) => (
              <div
                // A Scout's own label may match a built-in one.
                key={index}
                data-tile
                data-tone={TILE_TONES[index % TILE_TONES.length]}
                className={`rounded-md border border-l-4 border-neutral-200 bg-white/80 px-2.5 py-1.5 dark:border-neutral-800 dark:bg-neutral-950/80 ${TILE_CLASSES[TILE_TONES[index % TILE_TONES.length]!].border}`}
                {...(tile.hint ? { title: tile.hint } : {})}
              >
                <dt className="text-xs text-neutral-500">{tile.label}</dt>
                <dd
                  className={`whitespace-nowrap text-lg font-semibold tabular-nums ${TILE_CLASSES[TILE_TONES[index % TILE_TONES.length]!].value}`}
                >
                  {tile.value}
                </dd>
              </div>
            ))}
          </dl>
          {scout?.paused && (
            <p role="alert" className="whitespace-pre-wrap text-sm text-amber-700 dark:text-amber-400">
              {`Paused: ${scout.paused}`}
            </p>
          )}
          {scout?.error && (
            <p role="alert" className="whitespace-pre-wrap text-sm text-red-600 dark:text-red-400">
              {manifest ? `scout.json doesn't load, so the last good one stays: ${scout.error}` : scout.error}
            </p>
          )}
          {error && (
            <p role="alert" className="whitespace-pre-wrap text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
        </header>

        <div className={`grid gap-4 px-3 ${counsel ? 'lg:grid-cols-3' : ''}`}>
          <section aria-label="Items" className={`min-w-0 space-y-4 ${counsel ? 'lg:col-span-2' : ''}`}>
            {openCount === 0 && ticked.length === 0 ? (
              <p className="text-sm text-neutral-500">
                {board && board.runs.length > 0
                  ? 'Nothing to act on.'
                  : `Nothing yet. ${w('scouts')} report after their first run.`}
              </p>
            ) : view === 'table' ? (
              table
            ) : (
              <>
                {sections.open.map((group) => (
                  <section key={group.group ?? ''} aria-label={group.group ?? 'Other'} className="space-y-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      {(group.group !== undefined || sections.open.length > 1) && (
                        <h3 className="text-sm font-bold text-neutral-600 dark:text-neutral-300">
                          {group.group ?? 'Other'}
                        </h3>
                      )}
                      {manifest && <BatchActions items={group.items} manifest={manifest} perform={perform} />}
                    </div>
                    <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
                      {group.items.map(view === 'list' ? mailRow : row)}
                    </ul>
                  </section>
                ))}
                {ticked.length > 0 && (
                  <ul aria-label="Done" className="divide-y divide-neutral-200 dark:divide-neutral-800">
                    {ticked.map(row)}
                  </ul>
                )}
              </>
            )}

            {sections.snoozed.length > 0 && (
              <Folded title="Snoozed" plain="hidden until a time" count={sections.snoozed.length}>
                <ul className="divide-y divide-neutral-200 px-3 dark:divide-neutral-800">
                  {sections.snoozed.map((item) => (
                    <PastRow
                      key={item.id}
                      item={item}
                      note={item.until === undefined ? '' : `until ${new Date(item.until).toLocaleString()}`}
                      act={act}
                    />
                  ))}
                </ul>
              </Folded>
            )}
            {setAside.length > 0 && (
              <Folded title="Set aside" plain="done or dismissed" count={setAside.length}>
                <ul className="divide-y divide-neutral-200 px-3 dark:divide-neutral-800">
                  {setAside.map((item) => (
                    <PastRow key={item.id} item={item} note={item.state} act={act} />
                  ))}
                </ul>
              </Folded>
            )}
            {sections.gone.length > 0 && (
              <Folded title="Gone lately" plain="no longer in the collector's list" count={sections.gone.length}>
                <ul className="divide-y divide-neutral-200 px-3 dark:divide-neutral-800">
                  {sections.gone.map((item) => (
                    <PastRow key={item.id} item={item} note={`gone ${ago(item.goneAt ?? now, now)} ago`} />
                  ))}
                </ul>
              </Folded>
            )}
            {board && board.runs.length > 0 && (
              <Folded title="Recent runs" plain="the latest runs, newest first" count={board.runs.length}>
                <ul aria-label="Recent runs" className="divide-y divide-neutral-200 px-3 dark:divide-neutral-800">
                  {board.runs.map((run) => (
                    <RunRow key={run.id} run={run} now={now} />
                  ))}
                </ul>
              </Folded>
            )}
          </section>
          {/* The plan beside the inbox: sticky, so it stays in view down a long list. Above the list on narrower screens. */}
          {counsel && (
            <aside>
              <div className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
                {manifest && (
                  <Counsel
                    open={openItems}
                    manifest={manifest}
                    perform={perform}
                    act={act}
                    now={now}
                    {...(onQuest
                      ? {
                          start: async (ask: BoardQuest) => {
                            const { session } = await onQuest(ask);
                            if (session) onOpenQuest(session);
                          },
                        }
                      : {})}
                  />
                )}
              </div>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
