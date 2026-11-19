import type { BoardItem, ScoutItem, ScoutManifest } from '@crystal-bridge/protocol';
import { asTime, field, isSet } from './boards.js';
import { projectTone } from './theme/boardTones.js';

/** The `projects` Board view's model: items grouped by project, ordered and counted from data alone. */

type Look = ScoutManifest['projects'];
type Summary = ScoutManifest['summary'];
type ScoutLook = NonNullable<NonNullable<Look>['kind']>['values'][string];

/** Past this many rows a project folds the rest away. */
export const FOLD_AT = 8;

const DAY_MS = 86_400_000;

/** One project's rows and what the header shows of them. */
export interface ProjectSection<T extends ScoutItem = BoardItem> {
  name: string;
  url?: string;
  description?: string;
  owned?: boolean;
  tone: ReturnType<typeof projectTone>;
  items: T[];
  /** Items with a listed reason in the Needs-you lane. */
  needs: number;
  /** Items with a listed reason in the queue lane. */
  queued: number;
  /** Newest `when`, in ms. */
  latest?: number;
}

/** A row's slots, drawn from the manifest's looks. */
export interface RowLook {
  kind?: ScoutLook;
  marks: { field: string; look: ScoutLook }[];
  reason?: ScoutLook;
  who?: string;
  whoKey?: string;
  when?: number;
  comments?: number;
  added?: number;
  removed?: number;
  mine: boolean;
}

/** The project an item belongs to: its own, else its group, else Other. */
export function projectOf(item: ScoutItem): string {
  return item.project?.name ?? item.group ?? 'Other';
}

/** The look a field's value has in a `{ field, values }` block, when the value is listed. */
function lookup(
  item: ScoutItem,
  block: { field: string; values: Record<string, ScoutLook> } | undefined,
): ScoutLook | undefined {
  if (!block) return undefined;
  const value = field(item, block.field);
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return undefined;
  const key = String(value);
  return Object.hasOwn(block.values, key) ? block.values[key] : undefined;
}

/** Where a field's value sits among a block's listed values; unlisted ones come after. */
function listedAt(item: ScoutItem, block: { field: string; values: Record<string, ScoutLook> } | undefined): number {
  if (!block) return Number.MAX_SAFE_INTEGER;
  const value = field(item, block.field);
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return Number.MAX_SAFE_INTEGER;
  }
  const at = Object.keys(block.values).indexOf(String(value));
  return at < 0 ? Number.MAX_SAFE_INTEGER : at;
}

const whenOf = (item: ScoutItem, look: Look): number | undefined => asTime(field(item, look?.when));

/** Newest first; undated after dated; 0 for a tie. */
function newestFirst(a: number | undefined, b: number | undefined): number {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1;
  return b - a;
}

/** Which window an item's reason sends it to, if it has a listed reason: Needs you unless the reason says the queue. */
function laneOf(item: ScoutItem, look: Look): 'needs' | 'queue' | undefined {
  const reason = lookup(item, look?.reasons);
  if (!reason) return undefined;
  return reason.lane === 'queue' ? 'queue' : 'needs';
}

const needsYouFor = (item: ScoutItem, look: Look): boolean => laneOf(item, look) === 'needs';
const queuedFor = (item: ScoutItem, look: Look): boolean => laneOf(item, look) === 'queue';

/** Items grouped by project: Needs-you projects first, then the newest, then first seen; rows by kind, then newest. */
export function projectSections<T extends ScoutItem>(items: readonly T[], look: Look): ProjectSection<T>[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = projectOf(item);
    const list = groups.get(name);
    if (list) list.push(item);
    else groups.set(name, [item]);
  }
  const sections = [...groups].map(([name, list]): ProjectSection<T> => {
    const ordered = list
      .map((item, at) => ({ item, at, kind: listedAt(item, look?.kind), when: whenOf(item, look) }))
      .sort((a, b) => a.kind - b.kind || newestFirst(a.when, b.when) || a.at - b.at);
    const section: ProjectSection<T> = {
      name,
      tone: projectTone(name),
      items: ordered.map((row) => row.item),
      needs: list.filter((item) => needsYouFor(item, look)).length,
      queued: list.filter((item) => queuedFor(item, look)).length,
    };
    const url = list.find((item) => item.project?.url !== undefined)?.project?.url;
    const description = list.find((item) => item.project?.description !== undefined)?.project?.description;
    const owned = list.find((item) => item.project?.owned !== undefined)?.project?.owned;
    if (url !== undefined) section.url = url;
    if (description !== undefined) section.description = description;
    if (owned !== undefined) section.owned = owned;
    const times = ordered.flatMap((row) => (row.when === undefined ? [] : [row.when]));
    if (times.length > 0) section.latest = Math.max(...times);
    return section;
  });
  return sections
    .map((section, at) => ({ section, at }))
    .sort(
      (a, b) =>
        Number(b.section.needs > 0) - Number(a.section.needs > 0) ||
        newestFirst(a.section.latest, b.section.latest) ||
        a.at - b.at,
    )
    .map(({ section }) => section);
}

/** A field read as a count, from a number or a numeric string. */
function count(item: ScoutItem, name: string | undefined): number | undefined {
  const value = field(item, name);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const textOf = (item: ScoutItem, name: string | undefined): string | undefined => {
  const value = field(item, name);
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
};

/** What a row draws in each slot: the looks its field values have, and the fields the manifest names. */
export function rowLook(item: ScoutItem, look: Look): RowLook {
  return {
    kind: lookup(item, look?.kind),
    marks: (look?.marks ?? []).flatMap((mark) => {
      const found = lookup(item, mark);
      return found ? [{ field: mark.field, look: found }] : [];
    }),
    reason: lookup(item, look?.reasons),
    who: textOf(item, look?.who),
    whoKey: textOf(item, look?.whoKey),
    when: whenOf(item, look),
    comments: count(item, look?.comments),
    added: count(item, look?.added),
    removed: count(item, look?.removed),
    mine: isSet(field(item, look?.mine)),
  };
}

/** Items with a listed reason in the Needs-you lane: ranked first, then by reason order, newest, and input order. */
export function needsYou<T extends ScoutItem>(items: readonly T[], look: Look): T[] {
  const unranked = Number.MAX_SAFE_INTEGER;
  return items
    .map((item, at) => ({ item, at, reason: listedAt(item, look?.reasons), when: whenOf(item, look) }))
    .filter(({ item }) => needsYouFor(item, look))
    .sort(
      (a, b) =>
        (a.item.rank ?? unranked) - (b.item.rank ?? unranked) ||
        a.reason - b.reason ||
        newestFirst(a.when, b.when) ||
        a.at - b.at,
    )
    .map(({ item }) => item);
}

/** What the queue window orders an item by: its priority (lower first) and due time in ms, from the queue's fields. */
export function queueSlots(item: ScoutItem, look: Look): { priority?: number; due?: number } {
  return { priority: count(item, look?.queue?.priority), due: asTime(field(item, look?.queue?.due)) };
}

/** Lowest first; missing after present; 0 for a tie. */
function lowestFirst(a: number | undefined, b: number | undefined): number {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1;
  return a - b;
}

/** Items whose reason is in the queue lane: by priority, then soonest due, then oldest `when`, then input order. */
export function yourQueue<T extends ScoutItem>(items: readonly T[], look: Look): T[] {
  return items
    .map((item, at) => ({ item, at, ...queueSlots(item, look), when: whenOf(item, look) }))
    .filter(({ item }) => queuedFor(item, look))
    .sort(
      (a, b) =>
        lowestFirst(a.priority, b.priority) || lowestFirst(a.due, b.due) || lowestFirst(a.when, b.when) || a.at - b.at,
    )
    .map(({ item }) => item);
}

/** A due time in words, such as "due in 3d" or "overdue 2d"; within a day, "due today" or "overdue". */
export function dueText(due: number, now: number): string {
  const days = Math.floor(Math.abs(due - now) / DAY_MS);
  if (due >= now) return days === 0 ? 'due today' : `due in ${days}d`;
  return days === 0 ? 'overdue' : `overdue ${days}d`;
}

/** A priority badge's tone, by name from the Board palette: 0 red, 1 orange, 2 amber, 3 and after slate. */
export function priorityTone(priority: number): string {
  return priority < 1 ? 'red' : priority < 2 ? 'orange' : priority < 3 ? 'amber' : 'slate';
}

/** Items per local day over the last `days` days ending today, oldest first, by the `when` field. */
export function activity(items: readonly ScoutItem[], whenField: string | undefined, now: number, days = 14): number[] {
  const counts = new Array<number>(days).fill(0);
  const midnight = (time: number) => {
    const date = new Date(time);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  };
  const today = midnight(now);
  for (const item of items) {
    const time = asTime(field(item, whenField));
    if (time === undefined) continue;
    // Whole calendar days back, rounded so a daylight-saving day of 23 or 25 hours still counts as one.
    const back = Math.round((today - midnight(time)) / DAY_MS);
    if (back >= 0 && back < days) counts[days - 1 - back]! += 1;
  }
  return counts;
}

/** A project's header tiles: how many need you, then the first three summary counts over its items. */
export function tileCounts(
  section: ProjectSection,
  summary: Summary,
): { label: string; count: number; icon?: string; tone?: string }[] {
  const tiles: { label: string; count: number; icon?: string; tone?: string }[] = [
    { label: 'Needs you', count: section.needs, icon: 'hand', tone: 'amber' },
  ];
  for (const entry of (summary ?? []).slice(0, 3)) {
    const tile: (typeof tiles)[number] = {
      label: entry.label,
      count: section.items.filter((item) => isSet(field(item, entry.field))).length,
    };
    if (entry.icon !== undefined) tile.icon = entry.icon;
    if (entry.tone !== undefined) tile.tone = entry.tone;
    tiles.push(tile);
  }
  return tiles;
}

/** The first rows a project shows and how many it folds away, unless it's expanded. */
export function visibleRows<T>(items: readonly T[], expanded: boolean): { shown: T[]; hidden: number } {
  if (expanded || items.length <= FOLD_AT) return { shown: [...items], hidden: 0 };
  return { shown: items.slice(0, FOLD_AT), hidden: items.length - FOLD_AT };
}
