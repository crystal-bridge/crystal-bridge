import { useState } from 'react';
export interface SessionSummary {
  id: string;
  node: string;
  cwd: string;
  label: string;
  status: 'running' | 'idle' | 'ended' | 'closed';
  createdAt: number;
  /** When its latest event arrived; older hubs don't send it. */
  lastActivity?: number;
  /** Bytes the hub has sent clients about this session, all devices together. */
  relayedBytes?: number;
  /** The start of its latest finished turn's reply. */
  preview?: string;
}

export interface SessionListProps {
  sessions: SessionSummary[];
  selected: string | null;
  onSelect: (id: string) => void;
  /** Shows a New session button when given. */
  onNew?: () => void;
  /** What an empty list says. */
  empty?: string;
  /** Sessions waiting on an approval or a question. */
  waiting?: ReadonlySet<string>;
  now?: number;
}

/** "5m", "3h", "2d": how long ago a session started. */
function age(createdAt: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - createdAt) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

export function SessionList({
  sessions,
  selected,
  onSelect,
  onNew,
  empty = 'No sessions yet',
  waiting,
  now = Date.now(),
}: SessionListProps) {
  const [showClosed, setShowClosed] = useState(false);
  const closedCount = sessions.filter((s) => s.status === 'closed').length;
  // The selected session stays visible even if closed, so closing it doesn't make it vanish mid-view.
  const listed = showClosed ? sessions : sessions.filter((s) => s.status !== 'closed' || s.id === selected);
  return (
    <nav className="flex flex-col">
      {onNew && (
        <button
          type="button"
          onClick={onNew}
          className="m-3 rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          New session
        </button>
      )}
      <ul>
        {listed.length === 0 && <li className="px-3 py-2 text-sm text-neutral-500">{empty}</li>}
        {listed.map((session) => (
          <li key={session.id}>
            <button
              type="button"
              onClick={() => onSelect(session.id)}
              className={`w-full px-3 py-2 text-left text-sm hover:bg-neutral-200 dark:hover:bg-neutral-800 ${
                session.id === selected ? 'bg-neutral-200 dark:bg-neutral-800' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[session.status]}`}
                  title={session.status}
                />
                <span className="truncate font-medium">{session.label || session.id}</span>
                {waiting?.has(session.id) && (
                  <span
                    data-waiting
                    className="ml-auto shrink-0 rounded-full bg-amber-500 px-1.5 text-[10px] font-semibold leading-4 text-white"
                  >
                    needs you
                  </span>
                )}
              </div>
              <div className="truncate pl-4 text-xs text-neutral-500" title={session.cwd}>
                {session.cwd.split('/').filter(Boolean).at(-1) ?? session.cwd} · {age(session.createdAt, now)}
              </div>
            </button>
          </li>
        ))}
      </ul>
      {closedCount > 0 && (
        <button
          type="button"
          onClick={() => setShowClosed((show) => !show)}
          className="px-3 py-1.5 text-left text-xs text-neutral-500 hover:underline"
        >
          {showClosed ? 'Hide closed' : `Show ${closedCount} closed`}
        </button>
      )}
    </nav>
  );
}

export const STATUS_DOT: Record<SessionSummary['status'], string> = {
  running: 'bg-green-500',
  idle: 'bg-amber-400',
  ended: 'bg-neutral-400',
  closed: 'border border-neutral-400 bg-transparent',
};
