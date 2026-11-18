import { useEffect, useRef, useState } from 'react';
import type {
  Board,
  BoardItem,
  BoardItemState,
  ListedScout,
  ScoutAction,
  ScoutManifest,
  ScoutRun,
} from '@crystal-bridge/protocol';
import { actionsFor, batchesFor, boardSections, linkFor, settled, snoozeUntil, tableColumns } from '../boards.js';
import { duration } from '../format.js';
import { hint, scoutReturnLine, w } from '../theme/words.js';
import { Gold } from './Gold.js';
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
  /** Opens the Quest an action started. */
  onOpenQuest: (session: string) => void;
  onBack: () => void;
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
      <span className="flex gap-1">
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

function ItemText({ item, marked }: { item: BoardItem; marked: boolean }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="flex items-center gap-2">
        {marked && <NewMark />}
        <span className="truncate font-medium" title={item.title}>
          {item.title}
        </span>
      </span>
      {item.subtitle && <span className="block truncate text-xs text-neutral-500">{item.subtitle}</span>}
      {item.summary && <span className="block text-xs text-neutral-600 dark:text-neutral-300">{item.summary}</span>}
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
          {run.reason && ` · ${run.reason}`}
        </span>
        {run.costUsd !== undefined && (
          <span className="ml-auto text-xs">
            <Gold usd={run.costUsd} compact />
          </span>
        )}
      </div>
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
  const sections = boardSections(items, now);
  const view = manifest?.view ?? 'list';
  const lastRun = board?.runs[0] ?? scout?.lastRun;
  const isMarked = (item: BoardItem) => item.state === 'new' || marked.has(item.id);
  // A checklist keeps what's ticked in place; the other views fold it away with what was dismissed.
  const ticked = view === 'checklist' ? sections.setAside.filter((item) => item.state === 'done') : [];
  const setAside = view === 'checklist' ? sections.setAside.filter((item) => item.state !== 'done') : sections.setAside;
  const openCount = sections.open.reduce((total, group) => total + group.items.length, 0);

  const row = (item: BoardItem) => (
    <li key={item.id} className="flex items-center gap-3 py-1.5">
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
              <tr key={item.id}>
                <td className="py-1.5 pr-3">
                  <span className="flex items-center gap-2">
                    {isMarked(item) && <NewMark />}
                    <span className="font-medium">{item.title}</span>
                  </span>
                  {item.subtitle && <span className="block text-xs text-neutral-500">{item.subtitle}</span>}
                  {item.summary && (
                    <span className="block text-xs text-neutral-600 dark:text-neutral-300">{item.summary}</span>
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
        <header className="mx-3 space-y-2 border-b border-neutral-200 pb-3 dark:border-neutral-800">
          {back}
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
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
            {manifest && (
              <button
                type="button"
                disabled={running}
                onClick={() => void runNow()}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {running ? 'Asking…' : 'Run now'}
              </button>
            )}
          </div>
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

        <div className="space-y-4 px-3">
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
                  <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">{group.items.map(row)}</ul>
                </section>
              ))}
              {ticked.length > 0 && (
                <ul aria-label="Done" className="divide-y divide-neutral-200 dark:divide-neutral-800">
                  {ticked.map(row)}
                </ul>
              )}
            </>
          )}
        </div>

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
      </div>
    </div>
  );
}
