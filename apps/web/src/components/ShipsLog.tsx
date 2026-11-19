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
  /** Which releases the hub follows: full releases, or every build of `main` too. */
  channel?: ReleaseChannel;
  /** Present when an updater runs beside the hub, so Install updates works; with how the last install went. */
  install?: { progress?: InstallProgress };
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
export type ReleaseChannel = 'stable' | 'edge';

/** The updater's report on its last install (apps/airship/src/updater.ts). */
export interface InstallProgress {
  version: string;
  state: 'installing' | 'restarting' | 'done' | 'failed';
  from?: string;
  reason?: string;
  at: number;
}

/** How long "Updated from" stays after an install. */
const UPDATED_SHOWN_MS = 86_400_000;

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

/**
 * How to take an update. With an updater beside the hub, one press: it installs the hub, then Kingdoms that wait for
 * approval follow it. Without one, something outside the hub runs it, so the Log says how (`docs/OPERATIONS.md`).
 */
function TakeUpdate({
  update,
  install,
  onInstall,
}: {
  update: NonNullable<HubStatus['update']>;
  install: HubStatus['install'];
  onInstall: ((version: string) => void) | undefined;
}) {
  const progress = install?.progress?.version === update.version ? install.progress : undefined;
  const busy = progress?.state === 'installing' || progress?.state === 'restarting';
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
      {install && onInstall ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button
            type="button"
            disabled={busy}
            onClick={() => onInstall(update.version)}
            title={`Installs ${update.version} on the hub, which restarts; ${w('kingdoms')} waiting for approval follow it, each once it's idle`}
            className="rounded bg-blue-600 px-2 py-1 font-bold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Install updates
          </button>
          {progress?.state === 'installing' && <span>{`Installing ${update.version}…`}</span>}
          {progress?.state === 'restarting' && <span>{`Restarting on ${update.version}…`}</span>}
          {progress?.state === 'failed' && (
            <span role="alert" className="text-amber-700 dark:text-amber-400">
              {`${update.version} didn't install: ${progress.reason ?? 'no reason given'}`}
            </span>
          )}
        </div>
      ) : (
        <>
          <p className="text-xs">A hub is updated from outside it, and its Kingdoms follow:</p>
          <ul className="space-y-0.5 text-xs">
            <li>
              Container: pull <code className="font-mono">{hubImage(update.version)}</code> and recreate it.
            </li>
            <li>
              Deploy script:{' '}
              <code className="font-mono">scripts/deploy-airship-package.sh hub-host {update.version}</code>
            </li>
          </ul>
        </>
      )}
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
  onInstall,
  onChannel,
}: {
  /** Absent until the hub has answered. */
  status?: HubStatus | undefined;
  fleet: FleetRow[];
  now?: number;
  onChoice?: ((mode: KingdomUpdateMode) => void) | undefined;
  onApprove?: (() => void) | undefined;
  /** Asks the hub's updater for this release. */
  onInstall?: ((version: string) => void) | undefined;
  onChannel?: ((channel: ReleaseChannel) => void) | undefined;
}) {
  if (!status) return null;
  const done = status.install?.progress;
  const updated =
    done?.state === 'done' && done.version === status.release && now - done.at < UPDATED_SHOWN_MS ? done : undefined;
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
      {updated?.from && (
        <p className="text-xs text-neutral-500">{`Updated from ${updated.from} ${ago(updated.at, now)} ago`}</p>
      )}
      {status.update && <TakeUpdate update={status.update} install={status.install} onInstall={onInstall} />}
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
          {status.channel && onChannel && (
            <label className="flex items-center gap-1">
              Releases
              <select
                aria-label="Releases"
                value={status.channel}
                onChange={(event) => onChannel(event.target.value as ReleaseChannel)}
                title="Edge follows main: every merge, as soon as it's built and attested"
                className="cb-field py-0.5"
              >
                <option value="stable">Full releases</option>
                <option value="edge">Every build of main (edge)</option>
              </select>
            </label>
          )}
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
