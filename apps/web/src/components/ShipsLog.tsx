import { hubImage } from '@crystal-bridge/protocol';
import { bytes } from '../format.js';
import { fleetLine, type FleetRow } from '../fleet.js';
import { releaseLabel } from '../release.js';
import { hint, w } from '../theme/words.js';
import { ago } from './HomeParts.js';

/** `GET /api/hub/status`: the hub on itself. Only what this hub can report is there. */
export interface HubStatus {
  release: string;
  protocol: number;
  uptimeMs: number;
  databaseBytes?: number;
  lastBackupAt?: number;
  lastMirrorAt?: number;
  /** A newer release than this hub runs, when the hub checks. */
  update?: { version: string; url: string; notes: string };
  /** How Kingdoms follow this hub; absent on one that names no version. */
  kingdomUpdates?: {
    mode: KingdomUpdateMode;
    /** The release Kingdoms are told to run. */
    named: string;
    /** The newer release waiting to be approved. */
    offered?: string;
  };
}

export type KingdomUpdateMode = 'auto' | 'approved';

/** The mirror runs nightly, so this long without one means it stopped. */
const MIRROR_STALE_MS = 2 * 86_400_000;

/** What the logo's badge counts: what someone who stays inside a Kingdom would otherwise miss. */
export function logAttention(status: HubStatus | undefined): number {
  return (status?.update ? 1 : 0) + (status?.kingdomUpdates?.offered ? 1 : 0);
}

/** Whether Kingdoms follow by themselves, and the button that lets them when they don't. */
function KingdomUpdates({
  updates,
  onChoice,
  onApprove,
}: {
  updates: NonNullable<HubStatus['kingdomUpdates']>;
  onChoice?: ((mode: KingdomUpdateMode) => void) | undefined;
  onApprove?: (() => void) | undefined;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {onApprove && updates.offered && (
        <button
          type="button"
          onClick={onApprove}
          className="rounded border border-neutral-300 px-2 py-1 text-neutral-900 hover:bg-neutral-200 dark:border-neutral-700 dark:text-neutral-100 dark:hover:bg-neutral-800"
        >
          Update {w('kingdoms')} to {updates.offered}
        </button>
      )}
      {onChoice && (
        <label className="flex items-center gap-1">
          {`${w('kingdom')} updates`}
          <select
            value={updates.mode}
            onChange={(event) => onChoice(event.target.value as KingdomUpdateMode)}
            className="cb-field py-0.5"
          >
            <option value="auto">Automatic</option>
            <option value="approved">When approved</option>
          </select>
        </label>
      )}
    </div>
  );
}

/** How to take an update: a hub can't replace itself, because something outside it runs it (`docs/OPERATIONS.md`). */
function TakeUpdate({ update }: { update: NonNullable<HubStatus['update']> }) {
  return (
    <div className="space-y-1">
      <p className="font-medium">
        {update.version} is out.{' '}
        <a href={update.url} target="_blank" rel="noreferrer" className="font-normal underline">
          Release notes
        </a>
      </p>
      {update.notes && (
        <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-xs text-neutral-500">{update.notes}</p>
      )}
      <p className="text-xs">A hub is updated from outside it, and its Kingdoms follow:</p>
      <ul className="space-y-0.5 text-xs">
        <li>
          Container: pull <code className="font-mono">{hubImage(update.version)}</code> and recreate it.
        </li>
        <li>
          Deploy script: <code className="font-mono">scripts/deploy-airship-package.sh hub-host {update.version}</code>
        </li>
      </ul>
    </div>
  );
}

/**
 * The ship itself, beside everything about the fleet: one quiet line when all is well, opening by itself only when
 * something needs a look (#112). Its plain form is the hub.
 */
export function ShipsLog({
  status,
  fleet,
  now = Date.now(),
  onChoice,
  onApprove,
}: {
  /** Absent until the hub has answered. */
  status?: HubStatus | undefined;
  fleet: FleetRow[];
  now?: number;
  onChoice?: ((mode: KingdomUpdateMode) => void) | undefined;
  onApprove?: (() => void) | undefined;
}) {
  if (!status) return null;
  const lines = fleet.map((row) => ({ row, line: fleetLine(row, status.release) }));
  const flagged = lines.filter(({ line }) => line.attention).length;
  const mirrorStale = status.lastMirrorAt !== undefined && now - status.lastMirrorAt > MIRROR_STALE_MS;
  const summary =
    flagged > 0
      ? `${flagged} ${flagged === 1 ? w('kingdom') : w('kingdoms')} ${flagged === 1 ? 'needs' : 'need'} a look`
      : `${fleet.length} ${fleet.length === 1 ? w('kingdom') : w('kingdoms')} on course`;
  return (
    <section aria-label={w('shipsLog')} className="space-y-1">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="cb-display text-xl leading-none" title={hint('shipsLog')}>
          {w('shipsLog')}
        </h2>
        <p className="text-sm text-neutral-500">
          {releaseLabel(status.release)} · {summary}
        </p>
      </div>
      {status.update && <TakeUpdate update={status.update} />}
      {status.kingdomUpdates?.offered && onApprove && (
        <KingdomUpdates updates={status.kingdomUpdates} onApprove={onApprove} />
      )}
      <details open={flagged > 0 || mirrorStale} className="text-xs text-neutral-500">
        <summary className="cursor-pointer">Details</summary>
        <div className="mt-1 space-y-1">
          <p className="flex flex-wrap gap-x-3">
            <span>Protocol {status.protocol}</span>
            <span>{status.uptimeMs < 60_000 ? 'Just started' : `Up ${ago(now - status.uptimeMs, now)}`}</span>
            {status.databaseBytes !== undefined && <span>Database {bytes(status.databaseBytes)}</span>}
            {status.lastBackupAt !== undefined && <span>Backup {ago(status.lastBackupAt, now)} ago</span>}
            {status.lastMirrorAt !== undefined && (
              <span className={mirrorStale ? 'text-amber-700 dark:text-amber-400' : ''}>
                Mirror {ago(status.lastMirrorAt, now)} ago
              </span>
            )}
          </p>
          {status.kingdomUpdates && onChoice && <KingdomUpdates updates={status.kingdomUpdates} onChoice={onChoice} />}
          {lines.length > 0 && (
            <ul>
              {lines.map(({ row, line }) => (
                <li key={row.id} className={line.attention ? 'text-amber-700 dark:text-amber-400' : ''}>
                  {row.name}: {line.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
    </section>
  );
}
