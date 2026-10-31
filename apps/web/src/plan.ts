import type { UsageWindow } from '@crystal-bridge/protocol';

/** One plan bar on a Quest. */
export interface PlanBar {
  /** Percent left, 0-100. */
  left: number;
  resetsAt: number | null;
  /** Which limit this bar is showing, for its tooltip, e.g. `5-hour` or `weekly`. */
  limit: string;
  /** Set when the window itself says it's nearly out, or out, whatever its percentage. */
  warning?: 'low' | 'out';
}

const WEEK_HOURS = 168;

function limitName({ label, spanHours }: UsageWindow): string {
  // A label with more than its length in it names a narrower limit, which "weekly" would hide.
  if (spanHours === undefined || label.includes(' ')) return label;
  if (spanHours === WEEK_HOURS) return 'weekly';
  return spanHours % 24 === 0 ? `${spanHours / 24}-day` : `${spanHours}-hour`;
}

function bar(window: UsageWindow, now: number): PlanBar {
  const limit = limitName(window);
  // Past its reset, the reported figures belong to the previous window.
  if (window.resetsAt !== null && window.resetsAt <= now) return { left: 100, resetsAt: null, limit };
  const left = Math.max(0, Math.min(100, Math.round(100 - window.usedPct)));
  const warning = window.status === 'rejected' ? 'out' : window.status === 'allowed_warning' ? 'low' : undefined;
  return { left, resetsAt: window.resetsAt, limit, ...(warning ? { warning } : {}) };
}

/**
 * A plan's bars from whatever windows its engine reports. HP is the shortest, so a plan with no five-hour limit still
 * has one, and Stamina is the tightest of any longer ones: that's the one that will stop you. A window with no length
 * sorts last in the order it came, which also keeps a Kingdom from before lengths were sent working.
 */
export function planBars(plan: UsageWindow[] | undefined, now: number): { hp?: PlanBar; stamina?: PlanBar } {
  const [shortest, ...others] = [...(plan ?? [])].sort((a, b) => (a.spanHours ?? Infinity) - (b.spanHours ?? Infinity));
  if (!shortest) return {};
  const longer = others
    .filter((window) => (window.spanHours ?? Infinity) > (shortest.spanHours ?? 0))
    .map((window) => bar(window, now))
    .sort((a, b) => a.left - b.left);
  const [tightest] = longer;
  return { hp: bar(shortest, now), ...(tightest ? { stamina: tightest } : {}) };
}
