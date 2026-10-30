/**
 * The home pages' data: turn totals since a local time (the hub sums engine-neutral turn.finished payloads; the
 * client picks the boundaries, so "today" is the viewer's own), a Kingdom's most-used project folders, and the
 * activity feed's wording, which names no Quest for a Discreet Kingdom.
 */
import { w } from './theme/words.js';
import type { SessionSummary } from './components/SessionList.js';

/** One row of `GET /api/stats`: a node's finished turns since a time. */
export interface TurnStats {
  node: string;
  turns: number;
  kos: number;
  costUsd: number;
  durationMs: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** One row of `GET /api/activity`. */
export interface ActivityItem {
  session: string;
  node: string;
  label: string;
  ts: number;
  kind: 'started' | 'closed' | 'turn';
  outcome?: string;
}

export interface ProjectUse {
  cwd: string;
  name: string;
  /** How many Quests used it. */
  count: number;
  /** Its latest activity. */
  last: number;
}

/** Local midnight at or before `now`. */
export function startOfDay(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** Local midnight of the Monday that starts `now`'s week. */
export function startOfWeek(now: number): number {
  const day = new Date(startOfDay(now));
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return day.getTime();
}

/** The stats of the given nodes added together, as one row with no node. */
export function sumStats(rows: readonly TurnStats[], nodes: ReadonlySet<string>): TurnStats {
  const total: TurnStats = {
    node: '',
    turns: 0,
    kos: 0,
    costUsd: 0,
    durationMs: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  for (const row of rows) {
    if (!nodes.has(row.node)) continue;
    total.turns += row.turns;
    total.kos += row.kos;
    total.costUsd += row.costUsd;
    total.durationMs += row.durationMs;
    total.tokens.input += row.tokens.input;
    total.tokens.output += row.tokens.output;
    total.tokens.cacheRead += row.tokens.cacheRead;
    total.tokens.cacheWrite += row.tokens.cacheWrite;
  }
  return total;
}

/** A Kingdom's project folders by how many of its Quests used them, then by most recent use. */
export function recentProjects(sessions: readonly SessionSummary[], limit = 5): ProjectUse[] {
  const byCwd = new Map<string, ProjectUse>();
  for (const session of sessions) {
    const last = session.lastActivity ?? session.createdAt;
    const use = byCwd.get(session.cwd);
    if (use) {
      use.count += 1;
      use.last = Math.max(use.last, last);
    } else {
      const name = session.cwd.split('/').filter(Boolean).at(-1) ?? session.cwd;
      byCwd.set(session.cwd, { cwd: session.cwd, name, count: 1, last });
    }
  }
  return [...byCwd.values()].sort((a, b) => b.count - a.count || b.last - a.last).slice(0, limit);
}

/** One activity line; a Discreet Kingdom's lines say "a Quest" instead of its name. */
/** A Quest label for quoting: labels are cut-off prompts, so a cut mid-phrase ends in an ellipsis. */
function quoted(label: string): string {
  const trimmed = label.trimEnd().replace(/[\s,;:]+$/, '');
  return trimmed.length < label.length ? `${trimmed}…` : trimmed;
}

export function activityLine(item: ActivityItem, kingdom: string, discreet: boolean): string {
  const who = discreet || !item.label ? `a ${w('quest')}` : `“${quoted(item.label)}”`;
  if (item.kind === 'started') return `${kingdom}: ${who} set out`;
  if (item.kind === 'closed') return `${kingdom}: ${who} was completed`;
  if (item.outcome === 'error') return `${kingdom}: ${who} was KO’d`;
  if (item.outcome === 'interrupted') return `${kingdom}: ${who} was stopped`;
  return `${kingdom}: ${who} finished a turn`;
}
