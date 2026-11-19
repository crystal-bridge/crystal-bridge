import { useEffect, useState } from 'react';
import type {
  Board,
  BoardAct,
  BoardItem,
  BoardItemsChange,
  BoardQuest,
  BoardItemState,
  ListedScout,
  ScoutAction,
  ScoutItem,
  ScoutManifest,
  ScoutRun,
} from '@crystal-bridge/protocol';
import { refusal, UNREACHABLE } from './api.js';
import type { BoardsFrame, HubClient } from './hub.js';
import { applyOrder } from './tabOrder.js';

/** Scouts and their Boards in the app (docs/SCOUTS.md). A Board is drawn from data alone: nothing from a Scout runs here. */

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 } as const;

/** When a snooze action's `for`, such as `1d`, runs out. */
export function snoozeUntil(span: string, now: number): number {
  const unit = span.slice(-1) as keyof typeof UNIT_MS;
  return now + Number(span.slice(0, -1)) * (UNIT_MS[unit] ?? UNIT_MS.d);
}

/** A placeholder's value from an item: `{{url}}`, `{{id}}`, `{{title}}` or `{{fields.<name>}}`. */
function placeholder(name: string, item: ScoutItem): string | undefined {
  if (name.startsWith('fields.')) {
    const key = name.slice('fields.'.length);
    // Only the item's own fields: never what every object inherits, such as `constructor`.
    const value = item.fields && Object.hasOwn(item.fields, key) ? item.fields[key] : undefined;
    return value === undefined || value === null ? undefined : String(value);
  }
  if (name === 'url' || name === 'id' || name === 'title' || name === 'subtitle' || name === 'group') {
    return item[name];
  }
  return undefined;
}

/**
 * A link action's address for an item, or undefined. A placeholder that is the whole template goes in as it is; one
 * inside a longer address is escaped, so a field can't add a path or a query of its own. Item text is untrusted, so
 * only a web address that parses comes back.
 */
export function linkFor(template: string, item: ScoutItem): string | undefined {
  const whole = /^\{\{\s*([\w.-]+)\s*\}\}$/.exec(template);
  let missing = false;
  const filled = whole
    ? placeholder(whole[1]!, item)
    : template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, name: string) => {
        const value = placeholder(name, item);
        if (value === undefined) missing = true;
        return encodeURIComponent(value ?? '');
      });
  if (filled === undefined || missing) return undefined;
  try {
    const url = new URL(filled);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** An item's buttons: the actions it names, else the Scout's defaults, in that order, each declared by the Scout. */
export function actionsFor(item: ScoutItem, manifest: ScoutManifest): { key: string; action: ScoutAction }[] {
  const keys = item.actions ?? manifest.defaults ?? [];
  return keys.flatMap((key) => {
    const action = Object.hasOwn(manifest.actions, key) ? manifest.actions[key] : undefined;
    return action ? [{ key, action }] : [];
  });
}

/** A Board's pinned tab in the Kingdom's tab strip. */
export interface BoardTab {
  id: string;
  name: string;
  /** A name from the Board icon set; absent or unknown draws the name's first letter. */
  icon?: string;
  /** Items new since anyone looked. */
  fresh: number;
  /** A word or two on why the Scout isn't running as it should, when it isn't. */
  warn?: string;
  /** The Scout's own words on it. */
  reason?: string;
}

/** The Boards pinned on this device: every Scout's, less those it unpinned, in its saved order, then the hub's. */
export function boardTabs(
  scouts: readonly ListedScout[],
  unpinned: readonly string[],
  order: readonly string[] | undefined,
): BoardTab[] {
  const off = new Set(unpinned);
  const tabs = scouts
    .filter((scout) => !off.has(scout.id))
    .map((scout): BoardTab => {
      const tab: BoardTab = { id: scout.id, name: scout.manifest?.name ?? scout.id, fresh: scout.fresh };
      if (scout.manifest?.icon) tab.icon = scout.manifest.icon;
      if (scout.paused) Object.assign(tab, { warn: 'paused', reason: scout.paused });
      else if (scout.error) Object.assign(tab, { warn: "scout.json doesn't load", reason: scout.error });
      return tab;
    });
  return applyOrder(tabs, order);
}

/** A `list` row's slots, as a mail client shows them, read from the fields `show` names. */
export interface RowView {
  who?: string;
  /** What the sender's colour is keyed on: `show.whoKey`'s field, else the name shown. */
  whoKey?: string;
  /** Epoch ms. */
  when?: number;
  unread: boolean;
  preview?: string;
}

/** A field as a time: an ISO date, or a count of seconds or milliseconds since 1970. */
export function asTime(value: unknown): number | undefined {
  if (typeof value === 'string' && /^\d{9,}$/.test(value)) return asTime(Number(value));
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e11 ? value * 1000 : value;
  // Only what reads as a date: an ISO date, or one with a month name, as mail headers write them. `Date.parse` alone
  // takes "5" for a day in 2001.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}|[A-Za-z]{3}/.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

/** Set to anything but false, 0, empty or null. */
export const isSet = (value: unknown): boolean => Boolean(value);

export function field(item: ScoutItem, name: string | undefined): unknown {
  return name !== undefined && item.fields && Object.hasOwn(item.fields, name) ? item.fields[name] : undefined;
}

/** What a row shows in each slot the Scout's `show` names; a slot it can't read stays empty. */
export function rowView(item: ScoutItem, show: ScoutManifest['show']): RowView {
  const view: RowView = { unread: isSet(field(item, show?.unread)) };
  const who = text(field(item, show?.who));
  const when = asTime(field(item, show?.when));
  const preview = text(field(item, show?.preview));
  if (who !== undefined) {
    view.who = who;
    view.whoKey = text(field(item, show?.whoKey)) ?? who;
  }
  if (when !== undefined) view.when = when;
  if (preview !== undefined) view.preview = preview;
  return view;
}

/** The suggested action an item offers, if its suggestion names one. */
function suggestionFor(item: ScoutItem, manifest: ScoutManifest): { key: string; action: ScoutAction } | undefined {
  if (item.suggested === undefined) return undefined;
  const found = actionsFor(item, manifest).find(({ key }) => key === item.suggested);
  // A link with no web address to open draws no button, so it suggests nothing either.
  if (found?.action.kind === 'link' && linkFor(found.action.url, item) === undefined) return undefined;
  return found;
}

/** The banner's counts over the open items: how many, how many with a suggestion, and each count the Scout declares. */
export function boardCounts(
  open: readonly ScoutItem[],
  manifest: ScoutManifest | undefined,
): { open: number; suggested: number; declared: { label: string; count: number; icon?: string; tone?: string }[] } {
  return {
    open: open.length,
    suggested: manifest ? open.filter((item) => suggestionFor(item, manifest)).length : 0,
    declared: (manifest?.summary ?? []).map(({ label, field: name, icon, tone }) => ({
      label,
      count: open.filter((item) => isSet(field(item, name))).length,
      ...(icon !== undefined ? { icon } : {}),
      ...(tone !== undefined ? { tone } : {}),
    })),
  };
}

/** Suggested items gathered under the action suggested, best rank first; the group with the best item leads. */
export function recommendations<T extends ScoutItem>(
  open: readonly T[],
  manifest: ScoutManifest,
): { key: string; action: ScoutAction; items: T[] }[] {
  const unranked = Number.MAX_SAFE_INTEGER;
  const byRank = [...open].sort((a, b) => (a.rank ?? unranked) - (b.rank ?? unranked));
  const groups = new Map<string, { key: string; action: ScoutAction; items: T[] }>();
  for (const item of byRank) {
    const suggestion = suggestionFor(item, manifest);
    if (!suggestion) continue;
    const group = groups.get(suggestion.key);
    if (group) group.items.push(item);
    else groups.set(suggestion.key, { ...suggestion, items: [item] });
  }
  return [...groups.values()];
}

/**
 * When the synthesis step last ranked the list and what it cost: the newest run that paid for it without a reason
 * against it (a press that paid but failed says why). When the ranking is older than the runs the hub keeps, the
 * items still carry it, and it's `earlier`.
 */
export function lastSynthesis(
  runs: readonly ScoutRun[],
  items: readonly ScoutItem[],
): { at: number; costUsd: number } | { earlier: true } | undefined {
  const run = runs.find((one) => one.costUsd !== undefined && one.reason === undefined);
  if (run) return { at: run.finishedAt ?? run.startedAt, costUsd: run.costUsd! };
  return items.some((item) => item.rankSource === 'synthesis' || item.summarySource === 'synthesis')
    ? { earlier: true }
    : undefined;
}

export type BatchAction = Extract<ScoutAction, { kind: 'run' }>;

/** The `run` actions that take several items, each with the items that offer it, when more than one does. */
export function batchesFor(
  items: readonly ScoutItem[],
  manifest: ScoutManifest,
): { key: string; action: BatchAction; ids: string[] }[] {
  const batches = new Map<string, { key: string; action: BatchAction; ids: string[] }>();
  for (const item of items) {
    for (const { key, action } of actionsFor(item, manifest)) {
      if (action.kind !== 'run' || !action.batch) continue;
      const batch = batches.get(key);
      if (batch) batch.ids.push(item.id);
      else batches.set(key, { key, action, ids: [item.id] });
    }
  }
  return [...batches.values()].filter((batch) => batch.ids.length > 1);
}

export interface BoardSections {
  /** Items to act on, by group in the collector's order; ungrouped ones last. */
  open: { group: string | undefined; items: BoardItem[] }[];
  snoozed: BoardItem[];
  /** Done or dismissed, still in the collector's list. */
  setAside: BoardItem[];
  /** No longer in the collector's list. */
  gone: BoardItem[];
}

/** Where an item stands now: a snooze that has run out reads as new, as the hub reads it. */
export function settled(item: BoardItem, now: number): BoardItem {
  if (item.state !== 'snoozed' || (item.until !== undefined && item.until > now)) return item;
  const { until: _until, ...rest } = item;
  return { ...rest, state: 'new' };
}

/** Sorts a Board's items into what's open, by group, and what's folded away. */
export function boardSections(items: readonly BoardItem[], now: number, when?: string): BoardSections {
  const sections: BoardSections = { open: [], snoozed: [], setAside: [], gone: [] };
  const grouped = new Map<string | undefined, BoardItem[]>();
  // Ranked items first, by rank (from a collector or the synthesis step); the sort is stable, so ties and unranked items
  // keep the collector's order, and each group lands where its best item does.
  const unranked = Number.MAX_SAFE_INTEGER;
  const byRank = [...items].sort((a, b) => (a.rank ?? unranked) - (b.rank ?? unranked));
  for (const raw of byRank) {
    const item = settled(raw, now);
    if (item.goneAt !== undefined) sections.gone.push(item);
    else if (item.state === 'snoozed') sections.snoozed.push(item);
    else if (item.state === 'done' || item.state === 'dismissed') sections.setAside.push(item);
    else {
      const list = grouped.get(item.group);
      if (list) list.push(item);
      else grouped.set(item.group, [item]);
    }
  }
  // An inbox reads newest first: within each group, by the time field the Scout names; undated items keep their place
  // after the dated ones. The groups stay where their best-ranked item put them.
  if (when !== undefined) {
    const time = (item: BoardItem) => asTime(field(item, when));
    const newestFirst = (a: BoardItem, b: BoardItem) => {
      const [at, bt] = [time(a), time(b)];
      if (at === undefined || bt === undefined) return at === bt ? 0 : at === undefined ? 1 : -1;
      return bt - at;
    };
    for (const list of grouped.values()) list.sort(newestFirst);
  }
  const ungrouped = grouped.get(undefined);
  grouped.delete(undefined);
  sections.open = [...grouped].map(([group, list]) => ({ group, items: list }));
  if (ungrouped) sections.open.push({ group: undefined, items: ungrouped });
  return sections;
}

/** A table's columns: each field once, in the order the items first use them. */
export function tableColumns(items: readonly ScoutItem[]): string[] {
  const columns = new Set<string>();
  for (const item of items) for (const key of Object.keys(item.fields ?? {})) columns.add(key);
  return [...columns];
}

/** A Board with these items in place of their older selves. An item the Board doesn't hold is left out. */
export function withBoardItems(board: Board, changed: readonly BoardItem[]): Board {
  const byId = new Map(changed.map((item) => [item.id, item]));
  return { ...board, items: board.items.map((item) => byId.get(item.id) ?? item) };
}

const scoutsPath = (node: string) => `/api/nodes/${encodeURIComponent(node)}/scouts`;
const boardPath = (node: string, scout: string) => `${scoutsPath(node)}/${encodeURIComponent(scout)}`;

/**
 * A Kingdom's Scouts: the hub's list, then each new one as it comes. A frame that lands while the list is on its way is
 * newer than it, so it wins. Frames aren't replayed, so the list is read again when the socket comes back.
 */
export function useScouts(hub: HubClient, node: string | undefined): ListedScout[] {
  const [scouts, setScouts] = useState<ListedScout[]>([]);
  useEffect(() => {
    setScouts([]);
    if (!node) return;
    let latest = 0;
    let heard = false;
    const load = () => {
      latest += 1;
      const asked = latest;
      heard = false;
      void fetch(scoutsPath(node))
        .then((response) => (response.ok ? (response.json() as Promise<{ scouts?: ListedScout[] }>) : undefined))
        .then((loaded) => {
          if (!loaded || asked !== latest || heard) return;
          setScouts(loaded.scouts ?? []);
        })
        .catch(() => {});
    };
    load();
    const stopFrames = hub.onBoards((frame) => {
      if (frame.kind !== 'scouts' || frame.node !== node) return;
      heard = true;
      setScouts(frame.scouts);
    });
    const stopReconnect = hub.onReconnect(load);
    return () => {
      latest += 1;
      stopFrames();
      stopReconnect();
    };
  }, [hub, node]);
  return scouts;
}

function applyFrame(board: Board, frame: BoardsFrame): Board {
  if (frame.kind === 'board') return frame.board;
  if (frame.kind === 'board-items') return withBoardItems(board, frame.items);
  return board;
}

export interface BoardState {
  board: Board | null;
  /** The hub has no such Scout on that Kingdom. */
  missing: boolean;
  /** Why the Board didn't load, when it didn't for another reason. */
  failed?: string;
}

const NO_BOARD: BoardState = { board: null, missing: false };

/**
 * One Board, kept current like `useScouts`: frames heard while the Board loads are laid over it in order, and frames
 * after that go straight onto it.
 */
export function useBoard(hub: HubClient, node: string | undefined, scout: string | undefined): BoardState {
  const [state, setState] = useState<BoardState>(NO_BOARD);
  useEffect(() => {
    setState(NO_BOARD);
    if (!node || !scout) return;
    let latest = 0;
    let loading = false;
    let heard: BoardsFrame[] = [];
    const load = () => {
      latest += 1;
      const asked = latest;
      loading = true;
      heard = [];
      const settle = (next: (known: BoardState) => BoardState) => {
        if (asked !== latest) return;
        loading = false;
        heard = [];
        setState(next);
      };
      void fetch(boardPath(node, scout))
        .then(async (response) => {
          if (response.status === 404) return settle(() => ({ board: null, missing: true }));
          if (!response.ok) {
            const reason = (await refusal(response)).message;
            return settle((known) => ({ ...known, failed: reason }));
          }
          const loaded = (await response.json()) as Board;
          const replay = heard;
          settle(() => ({ board: replay.reduce(applyFrame, loaded), missing: false }));
        })
        .catch(() => settle((known) => ({ ...known, failed: UNREACHABLE })));
    };
    load();
    const stopFrames = hub.onBoards((frame) => {
      if (frame.node !== node || frame.kind === 'scouts') return;
      if ((frame.kind === 'board' ? frame.board.scout : frame.scout) !== scout) return;
      if (loading) heard.push(frame);
      setState((known) => (known.board ? { board: applyFrame(known.board, frame), missing: false } : known));
    });
    const stopReconnect = hub.onReconnect(load);
    return () => {
      latest += 1;
      stopFrames();
      stopReconnect();
    };
  }, [hub, node, scout]);
  return state;
}

/** Changes items' state on the hub, which tells every open Board, this one included. */
export async function changeBoardItems(
  node: string,
  scout: string,
  ids: string[],
  state: BoardItemState,
  until?: number,
): Promise<void> {
  const change: BoardItemsChange = { ids, state, ...(until === undefined ? {} : { until }) };
  let response: Response;
  try {
    response = await fetch(`${boardPath(node, scout)}/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(change),
    });
  } catch {
    throw new Error(UNREACHABLE);
  }
  if (!response.ok) throw await refusal(response);
}

/** Asks the Kingdom to run a Scout now. Its Board updates when the run ends. */
export async function runScoutNow(node: string, scout: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${boardPath(node, scout)}/run`, { method: 'POST' });
  } catch {
    throw new Error(UNREACHABLE);
  }
  if (!response.ok) throw await refusal(response);
}

/** Starts one Quest over Board items with the user's own prompt; the Kingdom adds the items as untrusted data. */
export async function startBoardQuest(node: string, scout: string, ask: BoardQuest): Promise<{ session?: string }> {
  let response: Response;
  try {
    response = await fetch(`${boardPath(node, scout)}/quest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ask),
    });
  } catch {
    throw new Error(UNREACHABLE);
  }
  if (!response.ok) throw await refusal(response);
  return (await response.json()) as { session?: string };
}

/** Has the Kingdom carry out a `quest` or `run` action on items. A Quest's id comes back, to open it. */
export async function actOnItems(
  node: string,
  scout: string,
  action: string,
  ids: string[],
): Promise<{ session?: string }> {
  const body: BoardAct = { action, ids };
  let response: Response;
  try {
    response = await fetch(`${boardPath(node, scout)}/act`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(UNREACHABLE);
  }
  if (!response.ok) throw await refusal(response);
  return (await response.json()) as { session?: string };
}
