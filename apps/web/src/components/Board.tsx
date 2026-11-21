import { type ReactNode, useEffect, useRef, useState } from 'react';
import type {
  Board,
  BoardQuest,
  BoardItem,
  BoardItemState,
  ListedScout,
  ScoutManifest,
  ScoutRun,
} from '@crystal-bridge/protocol';
import {
  actionsFor,
  batchesFor,
  boardCounts,
  boardSections,
  lastSynthesis,
  recommendations,
  rowView,
  settled,
  tableColumns,
} from '../boards.js';
import { duration, goldText, scheduleText, shortWhen } from '../format.js';
import { boardIcon, markIcon } from '../theme/boardIcons.js';
import {
  actionTone,
  BAND_CLASSES,
  bandTone,
  CHIP_CLASSES,
  SENDER_CLASSES,
  senderTone,
  TILE_CLASSES,
  tileTones,
} from '../theme/boardTones.js';
import { Icon } from '../theme/icons.js';
import { hint, scoutReturnLine, w } from '../theme/words.js';
import {
  Avatar,
  button,
  ItemActions,
  itemNote,
  KingdomButton,
  monogram,
  NewMark,
  PatrolThisContext,
  QuestAllButton,
  QuestComposer,
  questBatch,
  ROW_TOOLS,
  SourceMark,
  titleNote,
} from './BoardParts.js';
import { Gold } from './Gold.js';
import { ago, Folded, HOME_PAGE } from './HomeParts.js';
import { useBoardMode } from '../boardPrefs.js';
import { LayoutSwitch, ProjectsView } from './ProjectsView.js';
import { PatrolLog, PatrolsNext, type BoardPatrolsProps } from './PatrolLog.js';

export interface BoardPageProps {
  /** The Kingdom's name, for the way back. */
  kingdom: string;
  /** The Kingdom's id, which keys this device's choices for the Board; its name stands in without one. */
  node?: string;
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
  /** The Patrols that post to this Board and their reports; without them, no Patrol log. */
  patrols?: BoardPatrolsProps | undefined;
  /**
   * "Patrol this" on an item's Quest action: opens the Patrol form drafted from it; rejects with why it couldn't. Unset
   * where the Kingdom doesn't take Patrols from the app.
   */
  onPatrolThis?: ((action: string, item: BoardItem) => Promise<void>) | undefined;
}

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
  // Where the Scout says what unread is, a read message steps back: grey, its avatar faded.
  const read = show?.unread !== undefined && !view.unread;
  return (
    <li
      className="group relative flex items-start gap-3 py-2 pl-3 pr-1 hover:bg-neutral-50 dark:hover:bg-neutral-900"
      data-unread={view.unread}
      title={itemNote(item)}
    >
      {show?.unread !== undefined && view.unread && (
        <span aria-hidden data-unread-bar className="absolute inset-y-1 left-0 w-1 rounded-full bg-gold" />
      )}
      {view.who !== undefined && (
        <Avatar who={view.who} {...(view.whoKey ? { whoKey: view.whoKey } : {})} faded={read} />
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          {/* Where the Scout says what unread is, a dot says it (and words, for a screen reader); else the New mark. */}
          {show?.unread !== undefined
            ? view.unread && (
                <span className="h-2.5 w-2.5 shrink-0 self-center rounded-full bg-gold ring-2 ring-gold-bright/50">
                  <span className="sr-only">Unread</span>
                </span>
              )
            : marked && <NewMark />}
          <span
            {...(tone ? { 'data-tone': tone } : {})}
            className={`truncate ${strong ? 'font-semibold' : ''} ${read ? 'text-neutral-500 dark:text-neutral-400' : tone ? SENDER_CLASSES[tone].text : ''}`}
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
              className={
                strong
                  ? 'font-semibold'
                  : read
                    ? 'text-neutral-500 dark:text-neutral-400'
                    : 'text-neutral-700 dark:text-neutral-300'
              }
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
      <span data-row-tools className={ROW_TOOLS}>
        {actions}
      </span>
    </li>
  );
}

/**
 * A group's header as a band: the icon and tone the Scout names for it (`groups` in scout.json), else a neutral one, its
 * name in the display face, and how many of its items are unread where the Scout says what that is.
 */
function GroupBand({
  name,
  items,
  manifest,
}: {
  name: string;
  items: readonly BoardItem[];
  manifest: ScoutManifest | undefined;
}) {
  const look = manifest?.groups && Object.hasOwn(manifest.groups, name) ? manifest.groups[name] : undefined;
  const tone = bandTone(look?.tone);
  const mark = markIcon(look?.icon);
  const show = manifest?.show;
  const unread = show?.unread !== undefined ? items.filter((item) => rowView(item, show).unread).length : 0;
  return (
    <div
      data-band
      data-tone={tone}
      className={`flex min-w-0 flex-1 items-center gap-2 rounded-md border-l-4 px-3 py-1 ${BAND_CLASSES[tone].band}`}
    >
      {mark && (
        <span className={`shrink-0 ${BAND_CLASSES[tone].icon}`}>
          <Icon name={mark} size={20} />
        </span>
      )}
      <h3 title={name} className="cb-display truncate text-2xl leading-none">
        {name}
      </h3>
      <span className="ml-auto shrink-0 text-xs tabular-nums text-neutral-600 dark:text-neutral-300">
        {unread > 0 && <b className="text-amber-700 dark:text-amber-300">{`${unread} unread · `}</b>}
        {items.length}
      </span>
    </div>
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
  const suggested = groups.flatMap((group) => group.items);
  const batch = questBatch(suggested);
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
          <QuestAllButton label={batch.label} what="the suggestions here" onPress={() => setComposing(batch.best)} />
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
  node,
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
  patrols,
  onPatrolThis,
}: BoardPageProps) {
  const [marked, setMarked] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // Each item marked seen once while it stays new, so a slow answer doesn't send it again; once it's anything else, it
  // may come back as new and be marked again.
  const asked = useRef(new Set<string>());
  // A projects Board's layout on this device: its projects, or a tile each.
  const [mode, setMode] = useBoardMode(node ?? kingdom, scout?.id ?? board?.scout ?? '');

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
  // A projects view the Scout doesn't say how to draw falls back to the mail list.
  const mailList = view === 'list' || (view === 'projects' && !manifest?.projects);
  // A list with a time field reads newest first, like an inbox; the ranking moves to the Counsel pane.
  const sections = boardSections(items, now, mailList ? manifest?.show?.when : undefined);
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
  // The reports this Board's Patrols posted, beside the list (docs/PATROLS.md, Post to a Board).
  const log =
    patrols && patrols.patrols.length > 0 ? <PatrolLog {...patrols} onOpenQuest={onOpenQuest} now={now} /> : null;
  const aside = counsel || log !== null;
  const tiles: { label: string; value: string; hint?: string; icon?: string; tone?: string }[] = [
    { label: 'Open', value: String(counts.open), icon: 'tray', tone: 'sky' },
    {
      label: 'New',
      value: String(openItems.filter(isMarked).length),
      hint: 'new since anyone last looked',
      icon: 'sparkle',
      tone: 'amber',
    },
    ...(manifest?.synthesize || counts.suggested > 0
      ? [
          {
            label: 'Suggested',
            value: String(counts.suggested),
            hint: 'items with a suggested action',
            icon: 'lightbulb',
            tone: 'violet',
          },
        ]
      : []),
    ...counts.declared.map(({ label, count, icon, tone }) => ({
      label,
      value: String(count),
      ...(icon !== undefined ? { icon } : {}),
      ...(tone !== undefined ? { tone } : {}),
    })),
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
            icon: 'eye',
            tone: 'fuchsia',
          },
        ]
      : []),
  ];
  const tones = tileTones(tiles.map((tile) => tile.tone));

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

  // A Quest written on the Board opens once the Kingdom starts it.
  const start = onQuest
    ? async (ask: BoardQuest) => {
        const { session } = await onQuest(ask);
        if (session) onOpenQuest(session);
      }
    : undefined;
  // The projects view, where the Scout says how to draw one; without that block it falls back to the list.
  const projectsLook = view === 'projects' ? manifest?.projects : undefined;
  const empty = (
    <p className="text-sm text-neutral-500">
      {board.runs.length > 0 ? 'Nothing to act on.' : `Nothing yet. ${w('scouts')} report after their first run.`}
    </p>
  );

  const pastSections = (
    <>
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
    </>
  );

  // Failures land in the banner's alert, as the other actions' do.
  const patrolThis = onPatrolThis
    ? (action: string, item: BoardItem) => {
        setError(null);
        return onPatrolThis(action, item).catch((failure: unknown) =>
          setError(failure instanceof Error ? failure.message : String(failure)),
        );
      }
    : null;
  return (
    <PatrolThisContext.Provider value={patrolThis}>
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
                      <span title="its schedule, in its time zone"> · {scheduleText(manifest.schedule)}</span>
                    )}
                    {scout?.nextRunAt !== undefined && !scout.paused && (
                      <span> · next {new Date(scout.nextRunAt).toLocaleString()}</span>
                    )}
                    {manifest && scout?.nextRunAt === undefined && !scout?.paused && !scout?.error && (
                      <span title="a one-off that has run, or a rule that has ended: Run now still works">
                        {' '}
                        · no more runs
                      </span>
                    )}
                    {patrols && <PatrolsNext patrols={patrols.patrols} now={now} />}
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
                {projectsLook && <LayoutSwitch mode={mode} onMode={setMode} />}
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
              {tiles.map((tile, index) => {
                const tone = tones[index]!;
                const mark = markIcon(tile.icon);
                return (
                  <div
                    // A Scout's own label may match a built-in one.
                    key={index}
                    data-tile
                    data-tone={tone}
                    className={`flex items-center gap-2 rounded-md border border-l-4 border-neutral-200 bg-white/80 px-2.5 py-1.5 dark:border-neutral-800 dark:bg-neutral-950/80 ${TILE_CLASSES[tone].border}`}
                    {...(tile.hint ? { title: tile.hint } : {})}
                  >
                    {mark && (
                      <span className={`shrink-0 ${TILE_CLASSES[tone].value}`}>
                        <Icon name={mark} size={22} />
                      </span>
                    )}
                    <div className="min-w-0">
                      <dt className="text-xs text-neutral-500">{tile.label}</dt>
                      <dd
                        className={`whitespace-nowrap text-lg font-semibold tabular-nums ${TILE_CLASSES[tone].value}`}
                      >
                        {tile.value}
                      </dd>
                    </div>
                  </div>
                );
              })}
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

          {projectsLook && manifest ? (
            <ProjectsView
              items={openItems}
              manifest={manifest}
              look={projectsLook}
              now={now}
              node={node ?? kingdom}
              scout={scout?.id ?? board.scout}
              mode={mode}
              onMode={setMode}
              isMarked={isMarked}
              act={act}
              perform={perform}
              {...(start ? { start } : {})}
              empty={empty}
              past={pastSections}
              log={log}
            />
          ) : (
            <div className={`grid gap-4 px-3 ${aside ? 'lg:grid-cols-3' : ''}`}>
              <section aria-label="Items" className={`min-w-0 space-y-4 ${aside ? 'lg:col-span-2' : ''}`}>
                {openCount === 0 && ticked.length === 0 ? (
                  empty
                ) : view === 'table' ? (
                  table
                ) : (
                  <>
                    {sections.open.map((group) => (
                      <section key={group.group ?? ''} aria-label={group.group ?? 'Other'} className="space-y-1">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          {(group.group !== undefined || sections.open.length > 1) && (
                            <GroupBand name={group.group ?? 'Other'} items={group.items} manifest={manifest} />
                          )}
                          {manifest && <BatchActions items={group.items} manifest={manifest} perform={perform} />}
                        </div>
                        <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
                          {group.items.map(mailList ? mailRow : row)}
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

                {pastSections}
              </section>
              {/* The plan beside the inbox: sticky, so it stays in view down a long list. Above the list on narrower screens. */}
              {aside && (
                <aside>
                  <div className="space-y-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
                    {counsel && manifest && (
                      <Counsel
                        open={openItems}
                        manifest={manifest}
                        perform={perform}
                        act={act}
                        now={now}
                        {...(start ? { start } : {})}
                      />
                    )}
                    {log}
                  </div>
                </aside>
              )}
            </div>
          )}
        </div>
      </div>
    </PatrolThisContext.Provider>
  );
}
