import type { SessionSummary } from './components/SessionList.js';
import { hint } from './theme/words.js';

/** A Quest that had activity this recently is still active, whatever its process is doing. */
export const RECENT_MS = 24 * 60 * 60_000;

/** Put-away Quests per Kingdom: session id -> the Quest's last activity when it was put away. */
export type PutAway = Record<string, Record<string, number>>;

const STORAGE_KEY = 'crystal-bridge.put-away';

function lastActivity(session: SessionSummary): number {
  return session.lastActivity ?? session.createdAt;
}

/** A worktree's folder: Crystal's `.worktrees/<id>` or the CLI's `.claude/worktrees/<name>`. */
const WORKTREE = /\/(?:\.claude\/worktrees|\.worktrees)\/[^/]+\/?$/;

/** The folder a Quest works in, by its repository's name when it's in a worktree, whose own folder says nothing. */
export function projectName(cwd: string): string {
  return cwd.replace(WORKTREE, '').split('/').filter(Boolean).at(-1) ?? cwd;
}

/** Running, waiting on the user, or active in the last day. A closed Quest is history, never active. */
export function isActiveQuest(session: SessionSummary, now: number, waiting: ReadonlySet<string>): boolean {
  if (session.status === 'closed') return false;
  return session.status === 'running' || waiting.has(session.id) || now - lastActivity(session) < RECENT_MS;
}

/**
 * The Quests that get a tab, oldest first so tabs don't jump around: the active ones and the one shown. A Quest put
 * away on this device stays out until it has new activity, unless it needs the user.
 */
export function questTabs(
  sessions: readonly SessionSummary[],
  {
    now,
    shown,
    waiting,
    putAway,
  }: { now: number; shown: string | null; waiting: ReadonlySet<string>; putAway: Record<string, number> },
): SessionSummary[] {
  return sessions
    .filter((session) => {
      if (session.id === shown) return true;
      if (!isActiveQuest(session, now, waiting)) return false;
      const awayAt = putAway[session.id];
      return awayAt === undefined || waiting.has(session.id) || lastActivity(session) > awayAt;
    })
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Records that `session` on `node` was put away, as of its current last activity. */
export function putAway(all: PutAway, node: string, session: string, at: number): PutAway {
  return { ...all, [node]: { ...all[node], [session]: at } };
}

/** Storage can be missing or throw (private windows, blocked site data); fall back to nothing put away. */
export function loadPutAway(storage: Storage | undefined = globalThis.localStorage): PutAway {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const result: PutAway = {};
    for (const [node, entries] of Object.entries(parsed)) {
      if (typeof entries !== 'object' || entries === null) continue;
      result[node] = Object.fromEntries(
        Object.entries(entries).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
      );
    }
    return result;
  } catch {
    return {};
  }
}

export function savePutAway(all: PutAway, storage: Storage | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Not saved; the tab comes back after a reload.
  }
}

/** The plain label for a Quest's tab, its folder and status, for tooltips. */
export function questTitle(session: SessionSummary): string {
  return `${hint('quest')} · ${session.label || session.id} · ${projectName(session.cwd)} · ${session.status}`;
}
