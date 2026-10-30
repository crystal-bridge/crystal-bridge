import type { UsageWindow } from '@crystal-bridge/protocol';

/** One row of `GET /api/usage`: a node's latest usage report. */
export interface NodeUsageRow {
  node: string;
  ts: number;
  windows: UsageWindow[];
}

/** Reports older than this get an "as of" note: they only update while a session on that node runs. */
const STALE_MS = 5 * 60_000;

/** Time from `now` until `at`, as 37m, 3h12m or 2d4h; `now` once it has passed. */
export function formatUntil(at: number, now: number): string {
  const minutes = Math.floor((at - now) / 60_000);
  if (minutes <= 0) return 'now';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
  return `${minutes}m`;
}

type Level = 'low' | 'mid' | 'high';

function level(window: UsageWindow): Level {
  if (window.usedPct >= 80 || window.status === 'rejected') return 'high';
  if (window.usedPct >= 50 || window.status === 'allowed_warning') return 'mid';
  return 'low';
}

const LEVEL_CLASS: Record<Level, string> = {
  low: 'text-green-600 dark:text-green-400',
  mid: 'text-amber-600 dark:text-amber-400',
  high: 'text-red-600 dark:text-red-400',
};

function Window({ window, now }: { window: UsageWindow; now: number }) {
  // Past its reset, the reported percentage belongs to the previous window.
  if (window.resetsAt !== null && window.resetsAt <= now) {
    return <span className="text-neutral-500">{window.label} reset</span>;
  }
  const lvl = level(window);
  return (
    <span className="whitespace-nowrap">
      <span data-level={lvl} className={LEVEL_CLASS[lvl]}>
        {window.label} {Math.round(window.usedPct)}%
      </span>
      {window.resetsAt !== null && (
        <span className="text-neutral-500"> resets {formatUntil(window.resetsAt, now)}</span>
      )}
    </span>
  );
}

/** Plan usage per node, from each node's own account, so different Kingdoms can show different limits. */
export function NodeUsage({
  rows,
  now = Date.now(),
  named = true,
}: {
  rows: NodeUsageRow[];
  now?: number;
  /** Show each row's node name; off where the Kingdom is already named (its card, its Castle). */
  named?: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1 px-3 pt-2 text-xs">
      {rows.map((row) => (
        <div key={row.node}>
          <div className="flex items-baseline justify-between gap-2">
            {named && <span className="font-medium">{row.node}</span>}
            {now - row.ts > STALE_MS && <span className="text-neutral-500">as of {formatUntil(now, row.ts)} ago</span>}
          </div>
          <div className="flex flex-wrap gap-x-3">
            {row.windows.map((window) => (
              <Window key={window.id} window={window} now={now} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
